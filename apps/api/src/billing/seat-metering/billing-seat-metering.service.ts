import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { prisma, withTenantContext } from '@hrm/db';
import { SeatCapService } from '../../licensing/seat-cap.service';
import { BILLING_SEAT_SYNC_QUEUE } from '../../queue/queue.constants';
import { BILLING_SEAT_SYNC_ORCHESTRATOR_CRON, BILLING_SEAT_SYNC_ORCHESTRATOR_JOB_ID } from '../billing.constants';
import { BillingService } from '../billing.service';
import { STRIPE_CLIENT, StripeClient } from '../stripe/stripe-client.interface';

export interface BillingSeatSyncJobData {
  tenantId: string;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

/**
 * Keeps Stripe's billed subscription QUANTITY in sync with reality (step
 * 4.2) — a real per-seat SaaS billing need: a tenant that adds/removes
 * employees between explicit plan changes should still end up billed for
 * what they actually used. The SAME scheduled-BullMQ-orchestrator shape
 * `AnalyticsRollupService` (1.5) established — see that class's own doc
 * comment for the full "why a repeatable job, why `onModuleInit`,
 * idempotent re-registration" write-up, not repeated here.
 *
 * Deliberately `prorationBehavior: 'none'` — unlike `BillingService.changePlan`'s
 * interactive, immediately-prorated change, an automated background sync
 * should never surprise a tenant with a same-day micro-charge for one more
 * employee joining; the new quantity simply applies to the NEXT invoice,
 * Stripe's own standard behavior for an un-prorated quantity update.
 */
@Injectable()
export class BillingSeatMeteringService implements OnModuleInit {
  private readonly logger = new Logger(BillingSeatMeteringService.name);

  constructor(
    @InjectQueue(BILLING_SEAT_SYNC_QUEUE) private readonly queue: Queue<BillingSeatSyncJobData | Record<string, never>>,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
    private readonly seatCap: SeatCapService,
    private readonly billing: BillingService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'orchestrate',
      {},
      { ...JOB_OPTIONS, repeat: { pattern: BILLING_SEAT_SYNC_ORCHESTRATOR_CRON }, jobId: BILLING_SEAT_SYNC_ORCHESTRATOR_JOB_ID },
    );
    this.logger.log(`Registered the daily billing seat-sync orchestrator ("${BILLING_SEAT_SYNC_ORCHESTRATOR_CRON}" UTC).`);
  }

  /**
   * Fans out one job per tenant with a REAL Stripe subscription — a TRIAL
   * with no `stripeSubscriptionId` yet, or a CANCELED/PAST_DUE one, has
   * nothing to sync (see docs/conventions/billing.md).
   */
  async enqueueForEveryBilledTenant(): Promise<number> {
    const subscriptions = await prisma.subscription.findMany({
      where: { stripeSubscriptionId: { not: null }, status: { in: ['ACTIVE', 'TRIAL'] } },
      select: { tenantId: true },
    });
    await Promise.all(subscriptions.map((s) => this.queue.add('sync-tenant-seats', { tenantId: s.tenantId }, JOB_OPTIONS)));
    return subscriptions.length;
  }

  async syncTenantSeats(tenantId: string): Promise<void> {
    await withTenantContext(tenantId, async (tx) => {
      const subscription = await tx.subscription.findUnique({ where: { tenantId } });
      if (!subscription?.stripeSubscriptionId) {
        return;
      }
      const activeSeats = await this.seatCap.countActive(tx);
      if (subscription.quantity === activeSeats) {
        return;
      }
      const updated = await this.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        quantity: activeSeats,
        prorationBehavior: 'none',
      });
      await this.billing.applySubscriptionFromStripe(tx, tenantId, subscription.edition, updated);
    });
  }
}
