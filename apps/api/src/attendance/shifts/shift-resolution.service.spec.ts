/**
 * Integration test (real Postgres, no HTTP/Nest bootstrap needed — this
 * service has no injected dependencies), the SAME pattern
 * `notification-locale-resolver.service.spec.ts` (0.8) already establishes.
 * Proves the timezone-correctness requirement precisely and
 * deterministically — `resolveForClockIn` takes `clockInAt` as an explicit
 * parameter, so unlike a real clock-in over HTTP (which always uses "now"),
 * this can exercise exact instants without any wall-clock dependency. See
 * docs/conventions/attendance.md.
 */
import { prisma, withTenantContext } from '@hrm/db';
import { ShiftResolutionService } from './shift-resolution.service';

const TENANT_SLUG = 'shift-resolution-test';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('ShiftResolutionService.resolveForClockIn', () => {
  const service = new ShiftResolutionService();
  let tenantId: string;
  let usEmployeeId: string;
  let qaEmployeeId: string;
  let unrosteredEmployeeId: string;
  let nightShiftId: string;

  beforeAll(async () => {
    await resetFixtures();

    const tenant = await prisma.tenant.create({
      data: { name: 'Shift Resolution Test', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;

    const usBranch = await prisma.branch.create({
      data: { tenantId, name: 'Shift US Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    const qaBranch = await prisma.branch.create({
      data: { tenantId, name: 'Shift QA Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });

    const nightShift = await prisma.shiftDefinition.create({
      data: { tenantId, name: 'Night Shift', startTime: '22:00', endTime: '06:00', crossesMidnight: true },
    });
    nightShiftId = nightShift.id;

    const usEmployee = await prisma.employee.create({
      data: {
        tenantId,
        branchId: usBranch.id,
        employeeCode: 'SHIFT-US-1',
        firstName: 'US',
        lastName: 'Employee',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
      },
    });
    usEmployeeId = usEmployee.id;
    // A SINGLE-DAY roster assignment — deliberately not a multi-day range —
    // proves the two-step "check yesterday's roster too" lookup, not just
    // the easier case a continuous range would also get right.
    await prisma.rosterAssignment.create({
      data: {
        tenantId,
        employeeId: usEmployeeId,
        shiftDefinitionId: nightShiftId,
        effectiveFrom: new Date('2026-01-15T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-15T00:00:00.000Z'),
      },
    });

    const qaEmployee = await prisma.employee.create({
      data: {
        tenantId,
        branchId: qaBranch.id,
        employeeCode: 'SHIFT-QA-1',
        firstName: 'QA',
        lastName: 'Employee',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
      },
    });
    qaEmployeeId = qaEmployee.id;
    await prisma.rosterAssignment.create({
      data: {
        tenantId,
        employeeId: qaEmployeeId,
        shiftDefinitionId: nightShiftId,
        effectiveFrom: new Date('2026-01-20T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-20T00:00:00.000Z'),
      },
    });

    const unrostered = await prisma.employee.create({
      data: {
        tenantId,
        branchId: usBranch.id,
        employeeCode: 'SHIFT-NONE-1',
        firstName: 'No',
        lastName: 'Roster',
        employmentType: 'FULL_TIME',
        joinDate: new Date('2020-01-01'),
      },
    });
    unrosteredEmployeeId = unrostered.id;
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
  });

  it('attributes a clock-in just after midnight (America/New_York) to the PREVIOUS branch-local working day, resolving the shift from a SINGLE-DAY roster assignment', async () => {
    // 2026-01-16 00:45 America/New_York (EST, UTC-5) = 2026-01-16T05:45:00Z.
    const clockInAt = new Date('2026-01-16T05:45:00.000Z');
    const result = await withTenantContext(tenantId, (tx) =>
      service.resolveForClockIn(tx, usEmployeeId, clockInAt, 'America/New_York'),
    );
    expect(result.shift?.id).toBe(nightShiftId);
    expect(result.workDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('attributes a clock-in at the START of the shift (before midnight) to that SAME day', async () => {
    // 2026-01-15 22:15 America/New_York = 2026-01-16T03:15:00Z.
    const clockInAt = new Date('2026-01-16T03:15:00.000Z');
    const result = await withTenantContext(tenantId, (tx) =>
      service.resolveForClockIn(tx, usEmployeeId, clockInAt, 'America/New_York'),
    );
    expect(result.shift?.id).toBe(nightShiftId);
    expect(result.workDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('resolves the SAME crossing-midnight rule correctly for a DIFFERENT branch in a DIFFERENT timezone (Asia/Qatar, UTC+3)', async () => {
    // 2026-01-21 01:15 Asia/Qatar (UTC+3) = 2026-01-20T22:15:00Z.
    const clockInAt = new Date('2026-01-20T22:15:00.000Z');
    const result = await withTenantContext(tenantId, (tx) =>
      service.resolveForClockIn(tx, qaEmployeeId, clockInAt, 'Asia/Qatar'),
    );
    expect(result.shift?.id).toBe(nightShiftId);
    expect(result.workDate.toISOString()).toBe('2026-01-20T00:00:00.000Z');
  });

  it('an employee with no roster assignment at all gets no shift and the plain local calendar date', async () => {
    const clockInAt = new Date('2026-01-16T05:45:00.000Z');
    const result = await withTenantContext(tenantId, (tx) =>
      service.resolveForClockIn(tx, unrosteredEmployeeId, clockInAt, 'America/New_York'),
    );
    expect(result.shift).toBeNull();
    expect(result.workDate.toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });
});
