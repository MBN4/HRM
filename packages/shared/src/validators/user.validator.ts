import { z } from 'zod';

/**
 * Tenant user / team access management (step 7.1) — see
 * docs/conventions/user-management.md. Request DTOs for
 * `apps/api/src/users`; the first-login password-change DTO is in
 * `auth.validator.ts` next to the other auth DTOs.
 */

/** User account statuses a tenant admin may filter by (a subset of the `UserStatus` enum — PENDING/SUSPENDED are not produced by this module). */
export const USER_LIST_STATUSES = ['ACTIVE', 'DISABLED'] as const;

const roleIdsSchema = z.array(z.string().uuid()).min(1, 'assign at least one role').max(20);
const branchIdsSchema = z.array(z.string().uuid()).max(100);

export const createUserSchema = z
  .object({
    email: z.string().trim().email().max(254),
    roleIds: roleIdsSchema,
    /** Empty/omitted = unrestricted (every branch), matching `UserBranch`'s own semantics. */
    branchIds: branchIdsSchema.optional().default([]),
    /** Step 7.2 — who this person reports to (approval chain). Optional; set/changed later via `PATCH /users/:id/manager`. */
    managerId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Both fields optional but at least one required; `branchIds: []` explicitly clears the restriction. */
export const updateUserAccessSchema = z
  .object({
    roleIds: roleIdsSchema.optional(),
    branchIds: branchIdsSchema.optional(),
  })
  .strict()
  .refine((v) => v.roleIds !== undefined || v.branchIds !== undefined, { message: 'provide roleIds and/or branchIds' });
export type UpdateUserAccessInput = z.infer<typeof updateUserAccessSchema>;

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(USER_LIST_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** Step 7.2 — `managerId: null` clears the manager (top of a chain; approvals then go to the CEO). */
export const setUserManagerSchema = z.object({ managerId: z.string().uuid().nullable() }).strict();
export type SetUserManagerInput = z.infer<typeof setUserManagerSchema>;
