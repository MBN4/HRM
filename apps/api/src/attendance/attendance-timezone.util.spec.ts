import { addUtcDays, branchLocalToUtc, minutesFromHHmm, resolveWorkDate, toBranchLocal } from './attendance-timezone.util';

describe('attendance-timezone.util', () => {
  describe('toBranchLocal', () => {
    it('renders a UTC instant in America/New_York (UTC-5 in January, no DST)', () => {
      const local = toBranchLocal(new Date('2026-01-16T05:45:00.000Z'), 'America/New_York');
      expect(local.calendarDate.toISOString()).toBe('2026-01-16T00:00:00.000Z');
      expect(local.minutesOfDay).toBe(45); // 00:45 local
    });

    it('renders the SAME UTC instant differently for Asia/Qatar (UTC+3, no DST) — proving this is branch-timezone-driven, not server-local', () => {
      const local = toBranchLocal(new Date('2026-01-16T05:45:00.000Z'), 'Asia/Qatar');
      expect(local.calendarDate.toISOString()).toBe('2026-01-16T00:00:00.000Z');
      expect(local.minutesOfDay).toBe(8 * 60 + 45); // 08:45 local
    });
  });

  describe('minutesFromHHmm / addUtcDays', () => {
    it('converts "HH:mm" to minutes since midnight', () => {
      expect(minutesFromHHmm('00:00')).toBe(0);
      expect(minutesFromHHmm('06:00')).toBe(360);
      expect(minutesFromHHmm('22:00')).toBe(1320);
    });

    it('shifts a UTC-midnight calendar date by whole days', () => {
      const date = new Date('2026-01-16T00:00:00.000Z');
      expect(addUtcDays(date, -1).toISOString()).toBe('2026-01-15T00:00:00.000Z');
      expect(addUtcDays(date, 1).toISOString()).toBe('2026-01-17T00:00:00.000Z');
    });
  });

  describe('resolveWorkDate — the crossing-midnight day-attribution rule', () => {
    const nightShift = { startTime: '22:00', endTime: '06:00', crossesMidnight: true };
    const dayShift = { startTime: '09:00', endTime: '17:00', crossesMidnight: false };

    it('attributes a clock-in just after midnight (tail of a crossing shift) to the PREVIOUS calendar day', () => {
      // 2026-01-16 00:45 America/New_York (EST, UTC-5) = 2026-01-16T05:45:00Z.
      const workDate = resolveWorkDate(new Date('2026-01-16T05:45:00.000Z'), 'America/New_York', nightShift);
      expect(workDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    it('attributes a clock-in at the START of a crossing shift (before midnight) to that SAME calendar day', () => {
      // 2026-01-15 22:15 America/New_York (EST, UTC-5) = 2026-01-16T03:15:00Z.
      const workDate = resolveWorkDate(new Date('2026-01-16T03:15:00.000Z'), 'America/New_York', nightShift);
      expect(workDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    it('does NOT roll back a day for a non-crossing shift, even early in the morning', () => {
      // 2026-01-16 05:45 America/New_York local — before a 09:00 day shift even starts.
      const workDate = resolveWorkDate(new Date('2026-01-16T10:45:00.000Z'), 'America/New_York', dayShift);
      expect(workDate.toISOString()).toBe('2026-01-16T00:00:00.000Z');
    });

    it('falls back to the plain local calendar date with no resolved shift at all', () => {
      const workDate = resolveWorkDate(new Date('2026-01-16T05:45:00.000Z'), 'America/New_York', null);
      expect(workDate.toISOString()).toBe('2026-01-16T00:00:00.000Z');
    });

    it('resolves the SAME crossing-midnight rule correctly for a DIFFERENT branch timezone (Asia/Qatar, UTC+3)', () => {
      // 2026-01-21 01:15 Asia/Qatar (UTC+3) = 2026-01-20T22:15:00Z — tail of a shift that started 2026-01-20 22:00.
      const workDate = resolveWorkDate(new Date('2026-01-20T22:15:00.000Z'), 'Asia/Qatar', nightShift);
      expect(workDate.toISOString()).toBe('2026-01-20T00:00:00.000Z');
    });
  });

  describe('branchLocalToUtc — the reverse conversion used for lateness', () => {
    it('resolves a branch-local wall-clock time to the correct UTC instant (America/New_York, UTC-5)', () => {
      const utc = branchLocalToUtc(new Date('2026-01-15T00:00:00.000Z'), '09:00', 'America/New_York');
      expect(utc.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    it('resolves the SAME calendar date + time to a DIFFERENT UTC instant for Asia/Qatar (UTC+3)', () => {
      const utc = branchLocalToUtc(new Date('2026-01-15T00:00:00.000Z'), '09:00', 'Asia/Qatar');
      expect(utc.toISOString()).toBe('2026-01-15T06:00:00.000Z');
    });

    it('round-trips through toBranchLocal for a crossing-midnight scheduled start', () => {
      const utc = branchLocalToUtc(new Date('2026-01-15T00:00:00.000Z'), '22:00', 'America/New_York');
      const local = toBranchLocal(utc, 'America/New_York');
      expect(local.calendarDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
      expect(local.minutesOfDay).toBe(minutesFromHHmm('22:00'));
    });
  });
});
