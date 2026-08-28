import { computeRecordMetrics } from './attendance-metrics.util';

const US_OVERTIME_RULES = { dailyThresholdHours: 8, weeklyThresholdHours: 40, multiplier: 1.5 };
const QA_OVERTIME_RULES = { dailyThresholdHours: 8, multiplier: 1.25 };

// 2026-03-02 is before the US's 2026 DST transition (2026-03-08), so
// America/New_York is a stable UTC-5 (EST) for every case below — no DST
// edge case to account for in these fixtures.
describe('computeRecordMetrics — pack-driven overtime, THE RULE applied (no country-code branch)', () => {
  it('computes zero overtime for a shift exactly at the daily threshold, right on time', () => {
    const metrics = computeRecordMetrics({
      clockInAt: new Date('2026-03-02T14:00:00.000Z'), // 09:00 America/New_York (EST, UTC-5)
      clockOutAt: new Date('2026-03-02T22:00:00.000Z'), // 17:00 same day
      workDate: new Date('2026-03-02T00:00:00.000Z'),
      timeZone: 'America/New_York',
      shift: { startTime: '09:00', breakMinutes: 0 },
      overtimeRules: US_OVERTIME_RULES,
    });
    expect(metrics.workedMinutes).toBe(8 * 60);
    expect(metrics.overtimeMinutes).toBe(0);
    expect(metrics.lateMinutes).toBe(0);
  });

  it('computes overtime minutes past the US pack daily threshold, and lateness against the scheduled start', () => {
    const metrics = computeRecordMetrics({
      clockInAt: new Date('2026-03-02T14:30:00.000Z'), // 09:30 local — 30 min late
      clockOutAt: new Date('2026-03-02T23:00:00.000Z'), // 18:00 local — 8.5h worked
      workDate: new Date('2026-03-02T00:00:00.000Z'),
      timeZone: 'America/New_York',
      shift: { startTime: '09:00', breakMinutes: 0 },
      overtimeRules: US_OVERTIME_RULES,
    });
    expect(metrics.workedMinutes).toBe(8.5 * 60);
    expect(metrics.overtimeMinutes).toBe(30); // 8.5h - 8h threshold
    expect(metrics.lateMinutes).toBe(30);
  });

  it('applies the SAME function to a QA pack (different threshold/multiplier, same code path)', () => {
    const metrics = computeRecordMetrics({
      clockInAt: new Date('2026-03-02T04:00:00.000Z'), // 07:00 Asia/Qatar (UTC+3)
      clockOutAt: new Date('2026-03-02T14:00:00.000Z'), // 17:00 local — 10h worked
      workDate: new Date('2026-03-02T00:00:00.000Z'),
      timeZone: 'Asia/Qatar',
      shift: { startTime: '07:00', breakMinutes: 30 },
      overtimeRules: QA_OVERTIME_RULES,
    });
    expect(metrics.workedMinutes).toBe(10 * 60 - 30); // break deducted
    expect(metrics.overtimeMinutes).toBe(10 * 60 - 30 - 8 * 60);
    expect(metrics.lateMinutes).toBe(0);
  });

  it('deducts break minutes before comparing against the overtime threshold', () => {
    const metrics = computeRecordMetrics({
      clockInAt: new Date('2026-03-02T14:00:00.000Z'), // 09:00 local
      clockOutAt: new Date('2026-03-02T23:00:00.000Z'), // 18:00 local — 9h raw
      workDate: new Date('2026-03-02T00:00:00.000Z'),
      timeZone: 'America/New_York',
      shift: { startTime: '09:00', breakMinutes: 60 },
      overtimeRules: US_OVERTIME_RULES,
    });
    expect(metrics.workedMinutes).toBe(8 * 60); // 9h - 1h break = 8h, exactly at threshold
    expect(metrics.overtimeMinutes).toBe(0);
  });

  it('reports zero lateness with no resolved shift at all (nothing to be late against)', () => {
    const metrics = computeRecordMetrics({
      clockInAt: new Date('2026-03-02T14:00:00.000Z'),
      clockOutAt: new Date('2026-03-02T22:00:00.000Z'),
      workDate: new Date('2026-03-02T00:00:00.000Z'),
      timeZone: 'America/New_York',
      shift: null,
      overtimeRules: US_OVERTIME_RULES,
    });
    expect(metrics.lateMinutes).toBe(0);
  });

  it('correctly measures elapsed time across a midnight-crossing shift (real elapsed time, not modular clock arithmetic)', () => {
    // Shift starts 22:00 on workDate 2026-01-15, clock-in right on time,
    // clock-out at 06:00 the next calendar day — 8h elapsed.
    const metrics = computeRecordMetrics({
      clockInAt: new Date('2026-01-16T03:00:00.000Z'), // 22:00 America/New_York on Jan 15
      clockOutAt: new Date('2026-01-16T11:00:00.000Z'), // 06:00 America/New_York on Jan 16
      workDate: new Date('2026-01-15T00:00:00.000Z'),
      timeZone: 'America/New_York',
      shift: { startTime: '22:00', breakMinutes: 0 },
      overtimeRules: US_OVERTIME_RULES,
    });
    expect(metrics.workedMinutes).toBe(8 * 60);
    expect(metrics.overtimeMinutes).toBe(0);
    expect(metrics.lateMinutes).toBe(0);
  });
});
