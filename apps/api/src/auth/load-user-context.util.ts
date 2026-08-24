import type { Prisma } from '@hrm/db';

export interface LoadedUserContext {
  roles: string[];
  permissions: string[];
  /** null = unrestricted (no UserBranch rows). */
  branchIds: string[] | null;
}

/**
 * The single place that turns a user id into `{ roles, permissions,
 * branchIds }` — used by both `TenantScopeInterceptor` (populating the
 * request context from a verified JWT) and `AuthService.login` (returning
 * the same shape in the login response so a client has it immediately,
 * without waiting on the next request). Always queries through the
 * caller's already-open, RLS-scoped transaction.
 */
export async function loadUserContext(tx: Prisma.TransactionClient, userId: string): Promise<LoadedUserContext> {
  const userRoles = await tx.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const roles = userRoles.map((userRole) => userRole.role.name);
  const permissions = [
    ...new Set(userRoles.flatMap((userRole) => userRole.role.permissions.map((rp) => rp.permission.key))),
  ];

  const userBranches = await tx.userBranch.findMany({ where: { userId } });
  const branchIds = userBranches.length > 0 ? userBranches.map((userBranch) => userBranch.branchId) : null;

  return { roles, permissions, branchIds };
}
