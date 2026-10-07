import { apiFetch } from './client';

/** Mirrors `UserSummary` in `apps/api/src/users/users.service.ts` (step 7.1). */
export interface TeamUser {
  id: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED' | string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { id: string; name: string }[];
  /** Empty = unrestricted (every branch). */
  branches: { id: string; name: string }[];
  /** Whether the CALLER may edit/deactivate this user (the server re-checks regardless). */
  manageable: boolean;
  /** Step 7.2 — reporting line (`User.managerId`). */
  displayName: string | null;
  managerId: string | null;
  manager: { id: string; email: string; displayName: string | null } | null;
  directReportCount: number;
}

export type RoutingKind = 'DIRECT_MANAGER' | 'ESCALATED_MANAGER_UNAVAILABLE' | 'CEO_TOP_OF_CHAIN' | 'CEO_ESCALATED' | 'ADMIN_FALLBACK' | 'NO_APPROVER';

export interface ApprovalRouting {
  kind: RoutingKind;
  skipped: { userId: string; email: string | null; why: 'DEACTIVATED' | 'HR_EXCLUDED' | 'NOT_FOUND' }[];
}

/** One row of `GET /users/hierarchy` (step 7.2). */
export interface HierarchyUser {
  id: string;
  email: string;
  displayName: string | null;
  status: 'ACTIVE' | 'DISABLED' | string;
  /** Role NAMES, e.g. 'CEO', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE', 'TENANT_ADMIN'. */
  roles: string[];
  managerId: string | null;
  directReportCount: number;
  /** Who CURRENTLY approves THIS person's requests. */
  approvers: { id: string; email: string; displayName: string | null }[];
  routing: ApprovalRouting;
  isApprover: boolean;
}

/** Returned ONCE by create / regenerate — never retrievable again. */
export type TeamUserWithTempPassword = TeamUser & { temporaryPassword: string };

export interface TeamUserPage {
  items: TeamUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssignableRole {
  id: string;
  name: string;
  isSystem: boolean;
  /** False when the role carries a permission the caller doesn't hold. */
  assignable: boolean;
}

export function listUsers(params: { search?: string; status?: string; page?: number; pageSize?: number }): Promise<TeamUserPage> {
  return apiFetch<TeamUserPage>('/users', { query: params });
}

export function listAssignableRoles(): Promise<AssignableRole[]> {
  return apiFetch<AssignableRole[]>('/users/assignable-roles');
}

export function createUser(input: { email: string; roleIds: string[]; branchIds: string[]; managerId?: string | null }): Promise<TeamUserWithTempPassword> {
  return apiFetch<TeamUserWithTempPassword>('/users', { method: 'POST', body: input });
}

export function updateUserAccess(id: string, input: { roleIds?: string[]; branchIds?: string[] }): Promise<TeamUser> {
  return apiFetch<TeamUser>(`/users/${id}/access`, { method: 'PATCH', body: input });
}

export function deactivateUser(id: string): Promise<TeamUser> {
  return apiFetch<TeamUser>(`/users/${id}/deactivate`, { method: 'POST' });
}

export function reactivateUser(id: string): Promise<TeamUser> {
  return apiFetch<TeamUser>(`/users/${id}/reactivate`, { method: 'POST' });
}

export function regenerateTempPassword(id: string): Promise<TeamUserWithTempPassword> {
  return apiFetch<TeamUserWithTempPassword>(`/users/${id}/regenerate-temp-password`, { method: 'POST' });
}

export function getHierarchy(): Promise<{ items: HierarchyUser[] }> {
  return apiFetch<{ items: HierarchyUser[] }>('/users/hierarchy');
}

export function setUserManager(id: string, managerId: string | null): Promise<TeamUser> {
  return apiFetch<TeamUser>(`/users/${id}/manager`, { method: 'PATCH', body: { managerId } });
}
