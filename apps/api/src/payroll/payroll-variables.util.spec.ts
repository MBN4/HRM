import { buildPayrollVariables, computeYearsOfService, periodEndDate, periodStartDate } from './payroll-variables.util';

describe('computeYearsOfService', () => {
  it('computes fractional years between joinDate and asOfDate', () => {
    const years = computeYearsOfService(new Date('2020-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    expect(years).toBeCloseTo(6, 1);
  });

  it('clamps to zero for a join date after asOfDate', () => {
    expect(computeYearsOfService(new Date('2027-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))).toBe(0);
  });
});

describe('periodStartDate / periodEndDate', () => {
  it('resolves the first and last calendar day of a month, UTC', () => {
    expect(periodStartDate(2026, 2).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(periodEndDate(2026, 2).toISOString()).toBe('2026-02-28T00:00:00.000Z'); // 2026 is not a leap year
  });

  it('handles December correctly (rolls into next year for the end-date idiom)', () => {
    expect(periodStartDate(2026, 12).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(periodEndDate(2026, 12).toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('buildPayrollVariables — the variable-semantics contract', () => {
  it('aliases grossSalary/monthlySalary to the SAME period-gross figure, and annualizes for annualSalary', () => {
    const variables = buildPayrollVariables({ basicSalaryMonthly: 5000, periodGross: 5500, yearsOfService: 2.5 });
    expect(variables.basicSalary).toBe(5000);
    expect(variables.grossSalary).toBe(5500);
    expect(variables.monthlySalary).toBe(5500);
    expect(variables.annualSalary).toBe(5500 * 12);
    expect(variables.yearsOfService).toBe(2.5);
  });
});
