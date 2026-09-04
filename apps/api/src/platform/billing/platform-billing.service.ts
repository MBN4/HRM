import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { prisma, withTenantContext } from '@hrm/db';
import type { Invoice, Subscription } from '@hrm/db';
import type { CreateAmcInvoiceInput } from '@hrm/shared';
import { AuditRecordService } from '../../audit/audit-record.service';
import { BILLING_EVENTS } from '../../billing/billing-events';
import type { BillingSummary } from '../../billing/billing.service';
import { BillingService } from '../../billing/billing.service';
import { toDecimalFromMinorUnits } from '../../billing/money.util';
import { STRIPE_CLIENT, StripeClient } from '../../billing/stripe/stripe-client.interface';
import { PlatformAuditRecordService } from '../audit/platform-audit-record.service';

export interface PlatformSubscriptionSummary {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  edition: string;
  status: string;
  quantity: number | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The vendor console's own billing surface (step 4.2) — view/manage
 * subscriptions, see billing status per tenant, trigger AMC invoices. Every
 * mutation is dual-audited exactly like `PlatformTenantService` (4.1): the
 * TARGET TENANT's own `audit_log` (via the existing
 * `AuditRecordService.recordForTenant`, `actorPlatform: true`) AND the
 * platform's consolidated `PlatformAuditLog` — "never silent" made
 * concrete, the same posture every other platform-triggered tenant action
 * already takes. Queries cross-tenant through the owner `prisma` client /
 * `withTenantContext`, the SAME class of legitimate cross-tenant access
 * every other platform service in this codebase already documents for
 * itself.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
    private readonly billing: BillingService,
    private readonly auditRecord: AuditRecordService,
    private readonly platformAudit: PlatformAuditRecordService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Cheap indexed read — the SAME "cheap reads only, never a live heavy scan" posture PlatformUsageService already documents for itself. */
  async listSubscriptions(): Promise<PlatformSubscriptionSummary[]> {
    const subscriptions = await prisma.subscription.findMany({
      include: { tenant: { select: { name: true, slug: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return subscriptions.map((s) => ({
      tenantId: s.tenantId,
      tenantName: s.tenant.name,
      tenantSlug: s.tenant.slug,
      tenantStatus: s.tenant.status,
      edition: s.edition,
      status: s.status,
      quantity: s.quantity,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    }));
  }

  async getTenantBilling(tenantId: string): Promise<BillingSummary> {
    await this.requireTenant(tenantId);
    return withTenantContext(tenantId, (tx) => this.billing.getSummary(tx, tenantId));
  }

  /**
   * Invoice-only, no Stripe Subscription involved — the lifetime/on-prem
   * annual-maintenance path. Works for ANY tenant (a SaaS tenant could
   * conceivably owe a one-off charge too), but this is the named consumer
   * for lifetime-mode tenants, who otherwise never touch Stripe at all.
   */
  async createAmcInvoice(actorId: string, tenantId: string, input: CreateAmcInvoiceInput): Promise<Invoice> {
    await this.requireTenant(tenantId);

    const invoice = await withTenantContext(tenantId, async (tx) => {
      const subscription = await this.billing.ensureCustomer(tx, tenantId);
      const stripeInvoice = await this.stripe.invoices.create({
        customerId: subscription.stripeCustomerId!,
        currency: input.currency,
        amountMinorUnits: input.amountMinorUnits,
        description: input.description,
        dueDate: input.dueInDays ? addDays(new Date(), input.dueInDays) : undefined,
      });
      return tx.invoice.create({
        data: {
          tenantId,
          subscriptionId: null,
          type: 'AMC',
          status: stripeInvoice.status.toUpperCase() as 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE',
          stripeInvoiceId: stripeInvoice.id,
          stripeCustomerId: stripeInvoice.customerId,
          currency: stripeInvoice.currency,
          amountDue: toDecimalFromMinorUnits(stripeInvoice.amountDueMinorUnits),
          amountPaid: toDecimalFromMinorUnits(stripeInvoice.amountPaidMinorUnits),
          amountRemaining: toDecimalFromMinorUnits(stripeInvoice.amountRemainingMinorUnits),
          description: input.description,
          dueDate: stripeInvoice.dueDate,
          hostedInvoiceUrl: stripeInvoice.hostedInvoiceUrl,
          invoicePdfUrl: stripeInvoice.invoicePdfUrl,
          issuedAt: new Date(),
        },
      });
    });

    const after = { amountDue: invoice.amountDue.toString(), currency: invoice.currency, description: invoice.description };
    await this.auditRecord.recordForTenant({
      tenantId,
      actor: { userId: null, platform: true },
      action: 'billing.amc_invoice_created',
      entityType: 'Invoice',
      entityId: invoice.id,
      after,
      metadata: { platformAdminId: actorId },
    });
    await this.platformAudit.record({
      platformAdminId: actorId,
      action: 'billing.amc_invoice_created',
      entityType: 'Invoice',
      entityId: invoice.id,
      targetTenantId: tenantId,
      after,
    });
    this.eventEmitter.emit(BILLING_EVENTS.AMC_INVOICE_CREATED, {
      type: BILLING_EVENTS.AMC_INVOICE_CREATED,
      tenantId,
      invoiceId: invoice.id,
    });

    return invoice;
  }

  /**
   * A manual force-resync lever — pulls the tenant's subscription straight
   * from Stripe and re-applies it, for the rare case an admin suspects a
   * webhook delivery was missed. Cheap (one Stripe read), and reuses the
   * SAME `applySubscriptionFromStripe` mapping the webhook path uses, so
   * it can never disagree with what a webhook would have done.
   */
  async resyncSubscription(actorId: string, tenantId: string): Promise<Subscription> {
    await this.requireTenant(tenantId);
    return withTenantContext(tenantId, async (tx) => {
      const subscription = await tx.subscription.findUnique({ where: { tenantId } });
      if (!subscription?.stripeSubscriptionId) {
        throw new NotFoundException(`Tenant "${tenantId}" has no Stripe subscription to resync.`);
      }
      const stripeSub = await this.stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      if (!stripeSub) {
        throw new NotFoundException(`Stripe subscription "${subscription.stripeSubscriptionId}" was not found.`);
      }
      const updated = await this.billing.applySubscriptionFromStripe(tx, tenantId, subscription.edition, stripeSub);
      await this.platformAudit.record({
        platformAdminId: actorId,
        action: 'billing.subscription_resynced',
        entityType: 'Subscription',
        entityId: updated.id,
        targetTenantId: tenantId,
        after: { status: updated.status, edition: updated.edition, quantity: updated.quantity },
      });
      return updated;
    });
  }

  private async requireTenant(id: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${id}" was not found.`);
    }
    return tenant;
  }
}
