import { isPublicHoliday, isWeekend } from './attendance-day-status.util';

const US_WEEKEND = ['SATURDAY', 'SUNDAY'] as const;
const QA_WEEKEND = ['FRIDAY', 'SATURDAY'] as const;

describe('attendance-day-status.util — THE RULE: same function, pack-driven weekend/holiday', () => {
  describe('isWeekend', () => {
    it('a Friday is a WORKING day under the US pack but a WEEKEND day under the QA pack — same function, different data', () => {
      const friday = new Date('2026-03-06T00:00:00.000Z'); // a Friday
      expect(isWeekend(friday, US_WEEKEND)).toBe(false);
      expect(isWeekend(friday, QA_WEEKEND)).toBe(true);
    });

    it('a Saturday is a WEEKEND day under both packs', () => {
      const saturday = new Date('2026-03-07T00:00:00.000Z');
      expect(isWeekend(saturday, US_WEEKEND)).toBe(true);
      expect(isWeekend(saturday, QA_WEEKEND)).toBe(true);
    });

    it('a Sunday is a WEEKEND day under the US pack but a WORKING day under the QA pack', () => {
      const sunday = new Date('2026-03-08T00:00:00.000Z');
      expect(isWeekend(sunday, US_WEEKEND)).toBe(true);
      expect(isWeekend(sunday, QA_WEEKEND)).toBe(false);
    });
  });

  describe('isPublicHoliday', () => {
    const calendar = { '2026': [{ date: '2026-01-01', name: "New Year's Day" }] };

    it('matches a seeded holiday date', () => {
      expect(isPublicHoliday(new Date('2026-01-01T00:00:00.000Z'), calendar)).toBe(true);
    });

    it('does not match a non-holiday date', () => {
      expect(isPublicHoliday(new Date('2026-01-02T00:00:00.000Z'), calendar)).toBe(false);
    });

    it('does not match a year absent from the calendar', () => {
      expect(isPublicHoliday(new Date('2027-01-01T00:00:00.000Z'), calendar)).toBe(false);
    });
  });
});
