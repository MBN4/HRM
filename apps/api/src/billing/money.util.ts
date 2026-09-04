import { Prisma } from '@hrm/db';

/** Stripe's own convention: integer MINOR units (e.g. cents). Never a JS float division — see docs/conventions/payroll.md's money rule, reused verbatim for billing. */
export function toDecimalFromMinorUnits(minorUnits: number): Prisma.Decimal {
  return new Prisma.Decimal(minorUnits).dividedBy(100);
}
