import { formatMinutesAsHours, formatDate } from '../format';

describe('formatMinutesAsHours()', () => {
  it('formats whole hours and minutes', () => {
    expect(formatMinutesAsHours(90)).toBe('1h 30m');
    expect(formatMinutesAsHours(480)).toBe('8h 0m');
    expect(formatMinutesAsHours(0)).toBe('0h 0m');
  });

  it('handles negative durations with a leading sign', () => {
    expect(formatMinutesAsHours(-45)).toBe('-0h 45m');
  });

  it('renders the em dash placeholder for null/undefined', () => {
    expect(formatMinutesAsHours(null)).toBe('—');
    expect(formatMinutesAsHours(undefined)).toBe('—');
  });
});

describe('formatDate()', () => {
  it('renders the em dash placeholder for a missing date', () => {
    expect(formatDate(null, 'en')).toBe('—');
    expect(formatDate(undefined, 'en')).toBe('—');
  });

  it('formats a real ISO date', () => {
    const result = formatDate('2026-01-15T00:00:00.000Z', 'en');
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/Jan/);
  });
});
