import type { APIRequestContext } from '@playwright/test';
import { TEST_PASSWORD, type PortalTestFixtures } from './fixtures';

export const API = 'http://localhost:3001';

/** Local-calendar YYYY-MM-DD (the browser and this Node process share the machine timezone). */
export const ymdLocal = (d: Date = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymdLocal(d);
};
/** Sunday-first week start — the roster's own convention. */
export const weekStartOf = (ymd: string): string => addDays(ymd, -new Date(`${ymd}T12:00:00`).getDay());

export async function apiHeaders(request: APIRequestContext, fixtures: PortalTestFixtures, email: string): Promise<Record<string, string>> {
  const res = await request.post(`${API}/auth/login`, { headers: { 'x-tenant-id': fixtures.tenantASlug }, data: { email, password: TEST_PASSWORD } });
  if (!res.ok()) throw new Error(`login ${email} failed: ${res.status()} ${await res.text()}`);
  return { 'x-tenant-id': fixtures.tenantASlug, Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}` };
}

export interface ShiftBody {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  graceMinutes?: number;
  color?: string;
  minStaffing?: number | null;
}

export async function createShift(request: APIRequestContext, headers: Record<string, string>, body: ShiftBody): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API}/scheduling/shifts`, { headers, data: { breakMinutes: 60, graceMinutes: 15, ...body } });
  if (!res.ok()) throw new Error(`createShift failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { id: string; name: string };
}

export async function setCells(
  request: APIRequestContext,
  headers: Record<string, string>,
  cells: { employeeId: string; date: string; shiftDefinitionId?: string | null; dayOff?: boolean }[],
): Promise<void> {
  const res = await request.put(`${API}/scheduling/roster/cells`, { headers, data: { cells } });
  if (!res.ok()) throw new Error(`setCells failed: ${res.status()} ${await res.text()}`);
}

export async function publish(request: APIRequestContext, headers: Record<string, string>, from: string, to: string): Promise<void> {
  const res = await request.post(`${API}/scheduling/roster/publish`, { headers, data: { from, to } });
  if (!res.ok()) throw new Error(`publish failed: ${res.status()} ${await res.text()}`);
}

/** Wipes every roster cell for the given people in a window (admin = tenant-wide, so past days are allowed) and deletes the shifts. */
export async function cleanup(
  request: APIRequestContext,
  headers: Record<string, string>,
  employeeIds: string[],
  from: string,
  to: string,
  shiftIds: string[],
): Promise<void> {
  const cells: { employeeId: string; date: string }[] = [];
  for (const employeeId of employeeIds) for (let d = from; d <= to; d = addDays(d, 1)) cells.push({ employeeId, date: d });
  for (let i = 0; i < cells.length; i += 400) await request.put(`${API}/scheduling/roster/cells`, { headers, data: { cells: cells.slice(i, i + 400) } });
  for (const id of shiftIds) await request.delete(`${API}/scheduling/shifts/${id}`, { headers });
}
