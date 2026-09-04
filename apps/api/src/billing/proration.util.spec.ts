import { Prisma } from '@hrm/db';
import { computeProrationPreviewMinorUnits } from './proration.util';

describe('computeProrationPreviewMinorUnits', () => {
  const periodStart = new Date('2026-01-01T00:00:00.000Z');
  const periodEnd = new Date('2026-01-31T00:00:00.000Z'); // 30-day period

  it('charges the full delta when the change happens right at period start', () => {
    const result = computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: 1500,
      oldQuantity: 10,
      newSeatMonthlyMinorUnits: 3500,
      newQuantity: 10,
      periodStart,
      periodEnd,
      asOf: periodStart,
    });
    // oldMrr=15000, newMrr=35000, delta=20000, full period remaining -> 20000
    expect(result.toString()).toBe('20000');
  });

  it('prorates to roughly half when exactly halfway through the period', () => {
    const halfway = new Date(periodStart.getTime() + (periodEnd.getTime() - periodStart.getTime()) / 2);
    const result = computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: 1500,
      oldQuantity: 10,
      newSeatMonthlyMinorUnits: 3500,
      newQuantity: 10,
      periodStart,
      periodEnd,
      asOf: halfway,
    });
    // delta=20000, ~50% of the period remains -> ~10000
    expect(result.toNumber()).toBeGreaterThanOrEqual(9900);
    expect(result.toNumber()).toBeLessThanOrEqual(10100);
  });

  it('is zero once the period has already fully elapsed', () => {
    const result = computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: 1500,
      oldQuantity: 10,
      newSeatMonthlyMinorUnits: 3500,
      newQuantity: 10,
      periodStart,
      periodEnd,
      asOf: periodEnd,
    });
    expect(result.toString()).toBe('0');
  });

  it('produces a NEGATIVE (credit) amount for a downgrade', () => {
    const result = computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: 3500,
      oldQuantity: 20,
      newSeatMonthlyMinorUnits: 1500,
      newQuantity: 20,
      periodStart,
      periodEnd,
      asOf: periodStart,
    });
    expect(result.lessThan(0)).toBe(true);
    // oldMrr=70000, newMrr=30000, delta=-40000
    expect(result.toString()).toBe('-40000');
  });

  it('accounts for a seat-quantity increase, not just a price change', () => {
    const result = computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: 1500,
      oldQuantity: 10,
      newSeatMonthlyMinorUnits: 1500,
      newQuantity: 15,
      periodStart,
      periodEnd,
      asOf: periodStart,
    });
    // oldMrr=15000, newMrr=22500, delta=7500
    expect(result.toString()).toBe('7500');
  });

  it('returns a Prisma.Decimal instance, never a plain number', () => {
    const result = computeProrationPreviewMinorUnits({
      oldSeatMonthlyMinorUnits: 1500,
      oldQuantity: 10,
      newSeatMonthlyMinorUnits: 1500,
      newQuantity: 10,
      periodStart,
      periodEnd,
    });
    expect(result).toBeInstanceOf(Prisma.Decimal);
  });
});
