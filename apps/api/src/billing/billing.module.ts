import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LicensingModule } from '../licensing/licensing.module';
import { PlatformAuditRecordService } from '../platform/audit/platform-audit-record.service';
import { BILLING_SEAT_SYNC_QUEUE } from '../queue/queue.constants';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingSeatMeteringProcessor } from './seat-metering/billing-seat-metering.processor';
import { BillingSeatMeteringService } from './seat-metering/billing-seat-metering.service';
import { StripeModule } from './stripe/stripe.module';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { StripeWebhookService } from './webhooks/stripe-webhook.service';

/**
 * SaaS billing (step 4.2) — see docs/conventions/billing.md. Exports
 * `BillingService` so `PlatformModule`'s `PlatformBillingService` can reuse
 * `ensureCustomer`/`applySubscriptionFromStripe` for platform-triggered
 * actions (AMC invoicing, a manual resync) rather than re-implementing the
 * Stripe-object-to-row mapping a second time — the same cross-module reuse
 * shape `PlatformModule` already takes on `AuditModule`'s
 * `AuditRecordService`. `PlatformAuditRecordService` is registered locally
 * here too (a second, stateless instance — it depends only on the owner
 * `prisma` client) rather than importing `PlatformModule`, which would
 * create a circular import (`PlatformModule` imports THIS module for
 * `BillingService`) — the SAME small, accepted duplication
 * `PlatformModule`'s own doc comment already documents for `PasswordService`.
 */
@Module({
  imports: [
    StripeModule,
    // AuditModule is @Global() (see that module's own doc comment) — no
    // explicit import needed for AuditRecordService to resolve here.
    LicensingModule,
    BullModule.registerQueue({
      name: BILLING_SEAT_SYNC_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, StripeWebhookService, BillingSeatMeteringService, BillingSeatMeteringProcessor, PlatformAuditRecordService],
  // Re-exports StripeModule (Nest module exports are NOT transitive) so
  // PlatformBillingService, which injects STRIPE_CLIENT directly for the
  // AMC/resync paths BillingService doesn't itself expose, can resolve it
  // through this module too.
  exports: [BillingService, StripeModule],
})
export class BillingModule {}
