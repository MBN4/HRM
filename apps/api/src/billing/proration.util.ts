import { Prisma } from '@hrm/db';

export interface ProrationPreviewInput {
  oldSeatMonthlyMinorUnits: number;
  oldQuantity: number;
  newSeatMonthlyMinorUnits: number;
  newQuantity: number;
  /** The subscription's current billing period boundaries. */
  periodStart: Date;
  periodEnd: Date;
  /** Defaults to now. */
  asOf?: Date;
}

/**
 * A pure, Decimal-only PREVIEW of what an upgrade/downgrade would prorate
 * to — `(newMonthlyRecurringCharge - oldMonthlyRecurringCharge) *
 * fractionOfPeriodRemaining`, the standard "credit the unused portion of
 * the old rate, charge the remaining portion at the new rate" technique
 * real payment platforms use (Stripe's own included). Positive = an
 * additional charge (upgrade / more seats); negative = a credit
 * (downgrade / fewer seats).
 *
 * THIS IS A PREVIEW, not the authoritative charge — see
 * docs/conventions/billing.md. `BillingService.changePlan` calls Stripe
 * with `proration_behavior: 'create_prorations'` and lets STRIPE compute
 * the real, final proration on the resulting invoice; `StripeWebhookService`
 * records THAT number (also via `Prisma.Decimal`, converted from Stripe's
 * integer minor units) into the tenant's real `Invoice` row when the
 * `invoice.*` webhook arrives. Kept as its own pure function (unit-tested
 * with no Stripe/DB dependency at all — the SAME "pure function, its own
 * `.spec.ts`" posture `payroll-variables.util.ts` already establishes) so
 * the tenant portal can show a same-second estimate before the tenant
 * confirms a plan change, without waiting on a round trip to Stripe.
 *
 * `Prisma.Decimal` throughout — NEVER a JS float division — per
 * docs/conventions/payroll.md's money-handling rule, reused verbatim here.
 */
export function computeProrationPreviewMinorUnits(input: ProrationPreviewInput): Prisma.Decimal {
  const asOf = input.asOf ?? new Date();
  const totalMs = input.periodEnd.getTime() - input.periodStart.getTime();
  if (totalMs <= 0) {
    return new Prisma.Decimal(0);
  }
  const remainingMs = Math.max(0, Math.min(totalMs, input.periodEnd.getTime() - asOf.getTime()));
  const fraction = new Prisma.Decimal(remainingMs).dividedBy(totalMs);

  const oldMrr = new Prisma.Decimal(input.oldSeatMonthlyMinorUnits).times(input.oldQuantity);
  const newMrr = new Prisma.Decimal(input.newSeatMonthlyMinorUnits).times(input.newQuantity);

  return newMrr.minus(oldMrr).times(fraction).toDecimalPlaces(0);
}
