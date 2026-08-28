import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { prisma } from '@hrm/db';
import { FIXTURES_PATH, TEST_PASSWORD, type PortalTestFixtures } from './fixtures';
import { login, waitFor } from './helpers';

const fixtures: PortalTestFixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const API = 'http://localhost:3001';

test('MSS: approving a leave request from the inbox drives the real workflow to completion and deducts the balance', async ({ page, request }) => {
  // Submit as the employee via the real API (fast, deterministic) so this
  // test's focus stays on the MANAGER side of the flow.
  const loginRes = await request.post(`${API}/auth/login`, {
    headers: { 'x-tenant-id': fixtures.tenantASlug },
    data: { email: fixtures.employeeAEmail, password: TEST_PASSWORD },
  });
  const { accessToken } = await loginRes.json();

  // The US pack's ANNUAL entitlement only accrues monthly (starts at 0
  // available — see docs/conventions/leave.md), so grant a real balance
  // through the actual HR "manual grant" endpoint first, as the manager
  // (holds `leave.approve`) — additive, so re-running this suite never
  // breaks it (see also ess.spec.ts, which does the same for its own
  // February request).
  const managerLogin = await request.post(`${API}/auth/login`, {
    headers: { 'x-tenant-id': fixtures.tenantASlug },
    data: { email: fixtures.managerAEmail, password: TEST_PASSWORD },
  });
  const { accessToken: managerToken } = await managerLogin.json();
  await request.post(`${API}/leave/balances/${fixtures.employeeAId}/adjust`, {
    headers: { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${managerToken}` },
    data: { leaveType: 'ANNUAL', periodYear: 2027, deltaDays: 5 },
  });

  const before = await prisma.leaveBalance.findFirst({ where: { employeeId: fixtures.employeeAId, leaveType: 'ANNUAL' } });

  const submitRes = await request.post(`${API}/leave/requests`, {
    headers: { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${accessToken}` },
    data: { leaveType: 'ANNUAL', startDate: '2027-03-01', endDate: '2027-03-01', reason: 'Playwright MSS test' },
  });
  expect(submitRes.ok()).toBe(true);
  const submitted = await submitRes.json();
  expect(submitted.status).toBe('PENDING');

  // Now act as the manager, entirely through the UI. The card shows the
  // leave dates/type (not the free-text reason), so it's located by its
  // formatted start date, which is unique to this submission.
  await login(page, fixtures.tenantASlug, fixtures.managerAEmail);
  await page.goto('/approvals');

  const targetCard = page.locator('[data-testid="approval-card"][data-entity-type="LeaveRequest"]').filter({ hasText: 'Mar 1, 2027' });
  await expect(targetCard).toBeVisible();
  await targetCard.getByTestId('approve-button').click();

  await waitFor(async () => {
    const updated = await prisma.leaveRequest.findUnique({ where: { id: submitted.id } });
    return updated?.status === 'APPROVED' ? updated : null;
  });

  // The balance deduction is applied asynchronously by
  // `LeaveWorkflowEventsListener` reacting to `workflow.approved` — the
  // SAME "polled, not read immediately" posture leave.e2e-spec.ts already
  // takes for this exact reason (see docs/conventions/leave.md).
  const after = await waitFor(async () => {
    const balance = await prisma.leaveBalance.findFirst({ where: { employeeId: fixtures.employeeAId, leaveType: 'ANNUAL' } });
    return balance && balance.usedDays > (before?.usedDays ?? 0) ? balance : null;
  });
  expect(after.usedDays).toBeGreaterThan(before?.usedDays ?? 0);

  await expect(targetCard).toHaveCount(0);
});
