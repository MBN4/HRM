import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { prisma } from '@hrm/db';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const API = 'http://localhost:3001';

test.describe('ESS: leave', () => {
  test('applying for leave from the UI starts a real 0.7 workflow instance', async ({ page, request }) => {
    // The US reference pack's default ANNUAL entitlement only ACCRUES
    // monthly (starts at 0 available — see docs/conventions/leave.md), so
    // a fresh employee has nothing to spend yet. Grant a real balance
    // through the actual HR "manual grant" endpoint
    // (`POST /leave/balances/:employeeId/adjust`, `leave.approve`) rather
    // than writing the `LeaveBalance` row directly — this is exactly the
    // real feature that endpoint exists for.
    const managerLogin = await request.post(`${API}/auth/login`, {
      headers: { 'x-tenant-id': fixtures.tenantASlug },
      data: { email: fixtures.managerAEmail, password: TEST_PASSWORD },
    });
    const { accessToken: managerToken } = await managerLogin.json();
    await request.post(`${API}/leave/balances/${fixtures.employeeAId}/adjust`, {
      headers: { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${managerToken}` },
      data: { leaveType: 'ANNUAL', periodYear: 2027, deltaDays: 5 },
    });

    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/leave');

    await page.getByTestId('apply-leave-button').click();
    await page.locator('#leaveType').selectOption('ANNUAL');
    await page.locator('#startDate').fill('2027-02-01');
    await page.locator('#endDate').fill('2027-02-02');
    await page.locator('#reason').fill('Playwright ESS test');
    await page.getByRole('button', { name: /submit request/i }).click();

    await expect(page.getByTestId('leave-request-row').first()).toHaveAttribute('data-status', 'PENDING');

    const row = await waitFor(() =>
      prisma.leaveRequest.findFirst({
        where: { employeeId: fixtures.employeeAId, reason: 'Playwright ESS test' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(row.status).toBe('PENDING');
    expect(row.workflowInstanceId).toBeTruthy();

    const instance = await prisma.workflowInstance.findUnique({ where: { id: row.workflowInstanceId! } });
    expect(instance?.entityType).toBe('LeaveRequest');
    expect(instance?.entityId).toBe(row.id);
    // "PENDING" briefly, then "IN_STEP" once the manager-approval step
    // actually activates (see the WorkflowInstanceStatus enum) — either is
    // proof the instance is a real, still-open approval, not terminal.
    expect(['PENDING', 'IN_STEP']).toContain(instance?.status);
  });
});

test.describe('ESS: attendance', () => {
  test('clocking in from the UI creates a real 1.3 attendance record', async ({ page }) => {
    // Close out any OPEN record left by a previous run so this test is
    // deterministic on repeat local runs.
    await prisma.attendanceRecord.updateMany({
      where: { employeeId: fixtures.employeeAId, status: 'OPEN' },
      data: { status: 'CLOSED', clockOutAt: new Date() },
    });

    await login(page, fixtures.tenantASlug, fixtures.employeeAEmail);
    await page.goto('/attendance');

    await expect(page.getByTestId('clock-toggle-button')).toContainText(/clock in/i);
    await page.getByTestId('clock-toggle-button').click();
    await expect(page.getByTestId('clock-toggle-button')).toContainText(/clock out/i);

    const record = await waitFor(() =>
      prisma.attendanceRecord.findFirst({ where: { employeeId: fixtures.employeeAId, status: 'OPEN' }, orderBy: { createdAt: 'desc' } }),
    );
    expect(record.clockInSource).toBe('WEB');
    expect(record.branchId).toBe(fixtures.branchAUsId);

    // Clean up the open record so a re-run of this test (or the dashboard
    // widget in another spec) starts from a known "not clocked in" state.
    await prisma.attendanceRecord.update({ where: { id_workDate: { id: record.id, workDate: record.workDate } }, data: { status: 'CLOSED', clockOutAt: new Date() } });
  });
});
