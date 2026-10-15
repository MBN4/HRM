import type { Employee, Prisma } from '@hrm/db';

export type CallerEmployee = Pick<Employee, 'id' | 'userId' | 'branchId' | 'departmentId' | 'firstName' | 'lastName'>;

/** The caller's own Employee (an admin-only account may have none). */
export async function findCallerEmployee(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<CallerEmployee | null> {
  return tx.employee.findFirst({
    where: { tenantId, userId },
    select: { id: true, userId: true, branchId: true, departmentId: true, firstName: true, lastName: true },
  });
}

export const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();

/** employeeId -> display name, one query. */
export async function employeeNames(tx: Prisma.TransactionClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.employee.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(rows.map((r) => [r.id, fullName(r)]));
}

/** userId -> display name (the linked Employee's name, else the user's email). */
export async function userNames(tx: Prisma.TransactionClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const employees = await tx.employee.findMany({ where: { tenantId, userId: { in: unique } }, select: { userId: true, firstName: true, lastName: true } });
  for (const e of employees) if (e.userId) out.set(e.userId, fullName(e));
  const missing = unique.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const users = await tx.user.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, email: true } });
    for (const u of users) out.set(u.id, u.email.split('@')[0]);
  }
  return out;
}

/** UTC calendar date (00:00Z) of `d`. */
export function utcDate(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Parses an ISO date (`YYYY-MM-DD`) to its UTC midnight. */
export function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
