/**
 * Pure unit tests for `@hrm/shared`'s timezone formatting utilities — no DB
 * needed. Lives in `apps/api` rather than `packages/shared` because
 * `packages/shared` has no jest setup of its own, same precedent 0.5's
 * `pack-schema-sandbox.spec.ts` documents for the rules-engine schema.
 */
import { assertValidTimeZone, formatInTimeZone, InvalidTimeZoneError, toUtcIsoString } from '@hrm/shared';

describe('formatInTimeZone', () => {
  // A fixed UTC instant: 2026-01-15T12:00:00.000Z.
  const UTC_INSTANT = '2026-01-15T12:00:00.000Z';

  it('renders the SAME UTC instant differently for different IANA timezones', () => {
    const newYork = formatInTimeZone(UTC_INSTANT, 'America/New_York', { dateStyle: 'short', timeStyle: 'short' });
    const doha = formatInTimeZone(UTC_INSTANT, 'Asia/Qatar', { dateStyle: 'short', timeStyle: 'short' });

    // New York is UTC-5 in January -> 07:00; Doha is UTC+3 -> 15:00.
    expect(newYork).toContain('7:00');
    expect(doha).toContain('3:00');
    expect(newYork).not.toBe(doha);
  });

  it('respects the `locale` option for month/weekday naming', () => {
    const enLong = formatInTimeZone(UTC_INSTANT, 'UTC', { locale: 'en', dateStyle: 'full' });
    const arLong = formatInTimeZone(UTC_INSTANT, 'UTC', { locale: 'ar', dateStyle: 'full' });
    expect(enLong).not.toBe(arLong);
  });

  it('rejects a bogus timezone loudly rather than silently falling back to UTC', () => {
    expect(() => formatInTimeZone(UTC_INSTANT, 'Not/A_Zone')).toThrow(InvalidTimeZoneError);
    expect(() => assertValidTimeZone('Not/A_Zone')).toThrow(/not a recognized IANA timezone/);
  });

  it('accepts a Date instance as well as an ISO string', () => {
    const rendered = formatInTimeZone(new Date(UTC_INSTANT), 'UTC', { dateStyle: 'short', timeStyle: 'short' });
    expect(rendered).toContain('12:00');
  });
});

describe('toUtcIsoString', () => {
  it('always returns a UTC ISO-8601 string, from either a Date or an ISO string', () => {
    const fromString = toUtcIsoString('2026-01-15T12:00:00.000Z');
    const fromDate = toUtcIsoString(new Date('2026-01-15T12:00:00.000Z'));
    expect(fromString).toBe('2026-01-15T12:00:00.000Z');
    expect(fromDate).toBe('2026-01-15T12:00:00.000Z');
  });
});
