# Tenant user / team access management (+ privacy-policy page)

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 7.1 — `apps/api/src/users`, a small additive slice of
`apps/api/src/auth` + `apps/api/src/tenancy/tenant-scope.interceptor.ts`,
`packages/db` (one migration), `packages/shared`, `apps/portal`. Builds on
[auth-rbac.md](./auth-rbac.md) and [tenancy-rls.md](./tenancy-rls.md) —
read those first; this module **consumes** them (argon2id `PasswordService`,
`TokenService.revokeAllForUser`, `PermissionsCacheService.invalidate`, the
`@RequirePermissions` + `@AuditLog` interceptor shape, the forgot-password
flow) and re-implements none of it.

## The gap it closes

The system managed _employees_ and had a full RBAC engine, but a tenant
admin had **no way to manage who can log in** — users could only appear via
the platform's tenant bootstrap or SSO JIT provisioning. This module adds:
list / create / edit-access / deactivate / reactivate / regenerate-temp-
password, plus the forced first-login password change that makes an
HR-issued credential safe to hand over.

## The permission

`user.manage` — **already in the catalog** (`PERMISSIONS.USER_MANAGE`, step
0.4) and already seeded to `TENANT_ADMIN` (all permissions) and
`HR_MANAGER`; nothing had enforced it until now. No seed change was needed.
Enforcement reads the DB-backed role→permission rows like every other
permission, so a tenant can grant it to a custom role with no code change.

## Backend: `/users` (all routes require `user.manage`, deny-by-default)

| Route                                       | Purpose                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /users?search&status&page&pageSize`    | Paginated list: email, status, roles, branch scope, `lastLoginAt`, `mustChangePassword`, `manageable`. |
| `GET /users/assignable-roles`               | Every role + `assignable` (does the caller hold all of its permissions?) — drives the UI picker.       |
| `POST /users`                               | HR enters email + roleIds + optional branchIds → user created, temp password returned **once**.        |
| `PATCH /users/:id/access`                   | Replace roles and/or branch scope (`branchIds: []` = unrestricted).                                    |
| `POST /users/:id/deactivate` / `reactivate` | Status `DISABLED` ↔ `ACTIVE`.                                                                          |
| `POST /users/:id/regenerate-temp-password`  | New temp password, `mustChangePassword=true` again.                                                    |

**There is no DELETE.** Users are tied to audit/approval/workflow history, so
they are deactivated (`DISABLED`), never removed. Mutations are audited
(`@AuditLog('User', CREATE | UPDATE_ACCESS | DEACTIVATE | REACTIVATE |
REGENERATE_TEMP_PASSWORD)`); the audit layer's existing redaction regex
already matches `*password*`, so the `temporaryPassword` in the response is
stored as `[REDACTED]` (proven by test — the plaintext is searched for in the
audit rows). Responses carry `Cache-Control: no-store` (6.3's default).

### Temporary-password flow

1. `generateTemporaryPassword()` — `crypto.randomInt` (CSPRNG), 16 chars,
   guaranteed one upper/lower/digit/symbol, ambiguous characters (`0O1lI`)
   excluded because HR relays it to a person, then Fisher-Yates shuffled.
2. Hashed with the **existing** `PasswordService` (argon2id) — same as every
   user. Only the hash is stored.
3. The plaintext appears **only in that one HTTP response** (create or
   regenerate). It is never stored, logged, audited, or retrievable; the UI
   keeps it in component state until the dialog closes. If HR loses it, they
   regenerate (the old one is overwritten and every session revoked).

### Guards (second layer — RLS is the first)

All enforced server-side in `UsersService`; the UI hides actions via the
`manageable` flag but never relies on that.

- **Can't act on yourself**: no self-deactivate, self-edit of roles/branches,
  or self temp-password regeneration (use forgot-password).
- **Last active admin**: a user holding the system `TENANT_ADMIN` role can't be
  deactivated, nor demoted off it, if they're the only other-than-actor
  `ACTIVE` holder → `409`. (Reachable only by a non-admin that passes the
  escalation guard, e.g. a custom all-permissions role — the test builds one.)
- **Can't grant what you don't have**: every role being assigned must have all
  its permissions inside the caller's own set (`403` otherwise).
- **Can't manage someone more privileged than you** (the one that matters
  most): the target's _current_ roles' permissions must be ⊆ the caller's. Without
  it an `HR_MANAGER` (holds `user.manage`) could regenerate the admin's temp
  password and sign in as them. Proven by test.
- **Branch scope**: a branch-restricted caller may only assign scopes inside
  their own, may not grant "unrestricted" (empty list), and may only manage
  users inside their branch scope. The list is filtered the same way.
- Email uniqueness is case-insensitive within the tenant (`409`); the same
  email may exist in different tenants.

### Cache + session coherence

- Role/branch edits call `PermissionsCacheService.invalidate()` — this is the
  real role-assignment write path 5.1's cache doc said must do so; the change
  applies on the target's very next request (tested with a warmed cache).
- Deactivate: `status=DISABLED` is already enforced on every request by
  `TenantScopeInterceptor` (it re-reads the user row), so live access tokens
  die immediately; `TokenService.revokeAllForUser` stops refresh tokens
  minting new ones; login refuses non-`ACTIVE` accounts.
- Reactivate restores login with the user's existing password.

## Forced first-login password change

**Schema** (migration `20261007090000_add_user_must_change_password`):
`User.mustChangePassword Boolean @default(false)` and `User.lastLoginAt
DateTime?` (set in `AuthService.issueSession`, i.e. password and MFA logins).
No new RLS/grants needed — both are columns on an existing RLS table.

**Behavior**

- A user created or regenerated by HR has `mustChangePassword=true`.
- `POST /auth/login` still authenticates normally and returns
  `mustChangePassword` in the session. `GET /auth/me` also returns it.
- **Server-side enforcement** — in `TenantScopeInterceptor.authenticate()`,
  which already loads the user row, a `mustChangePassword` user is rejected
  with `403 { code: 'PASSWORD_CHANGE_REQUIRED' }` on **every** authenticated
  route **except** those carrying `@AllowPasswordChangePending()`: `POST
/auth/first-login/password`, `GET /auth/me`, `POST /auth/logout`, `POST
/auth/logout-all`. Deny-by-default — a new route is blocked for such a user
  unless it opts in. Anonymous routes (`/auth/refresh`, branding) are
  unaffected, and a refreshed token is still blocked (the flag lives on the
  row, not in the token). The distinct `code` lets clients tell it from RBAC 403. This is the only change to the auth core: one check of an
  already-loaded column plus one decorator.
- `POST /auth/first-login/password {newPassword}` (min 8, like every
  password): only valid while the flag is true (`400` after); **no
  `currentPassword`** field (they just authenticated with the temp one);
  rejects a new password equal to the temp one; hashes (argon2id), clears the
  flag, **revokes every refresh family**, and returns a **fresh session** so
  the user continues without re-logging-in. Emits `auth.password_changed`.
- After the first change the temp password is dead and the flag stays false.
  The only ways to change a password afterwards are forgot-password/reset and
  the existing Settings change-password (which needs the current one) — both
  unchanged. A completed **reset** also clears a pending flag (it proves
  email possession).
- **SSO** login for a still-flagged user keeps the flag (the password
  credential is still live and must be retired), so they hit the same screen.
- Impersonation of a flagged user is blocked like any other request.

**Portal**: `(app)/layout.tsx`'s `AuthGate` renders `ForcedPasswordChange`
**instead of the app shell** while `user.mustChangePassword` — nothing else
fetches. UI is UX only; the API enforces independently.

## Frontend (`apps/portal`)

- `/users` (nav "Team access", admin group, shown only with `user.manage`;
  the page also renders a no-access notice — the API 403s regardless). Distinct
  from `/team` (manager attendance/leave view). Search (debounced,
  server-side), status filter (styled `Select`), pagination, status/"must
  change password" badges, row actions.
- New design-system pieces: `ui/ConfirmDialog` (owns in-flight/error state,
  on `Modal`), `ui/CopyField` (LTR-pinned secret + copy with clipboard
  fallback), `users/TempPasswordPanel`, `users/RoleBranchPicker`,
  `users/CreateUserForm`, `users/EditAccessForm`, `auth/ForcedPasswordChange`,
  `layout/PolicyLinks`. Logical (start/end) spacing throughout → RTL mirrors;
  strings in the shared catalog (`users.*`, `auth.firstLogin.*`, en + ar).
- Create → on success the one-time password dialog (copy + "shown once"
  warning) opens; regenerate reuses it.

## Privacy policy page

`/privacy-policy` — **outside** the `(app)` route group so it's reachable
signed-out. Linked from the login footer (`PolicyLinks`, also on the forced-
change screen) and the app footer. Static, no API calls. Content is a
**template** (`lib/privacy-policy-content.ts`, full en + ar text; chrome in the
catalog) covering data collected, uses, legal bases, sharing/sub-processors,
residency, retention, **rights** (export/erasure described to match what
[privacy-residency.md](./privacy-residency.md) actually does: structured export;
erasure with legally-retained payroll records and audit-log _anonymization_,
never row deletion), security, cookies/local storage, contact. A prominent
banner states it is a **template, not legal advice, to be reviewed by legal
before production use**; org-specific facts are `[bracketed]` placeholders and
the product name is `{{product}}` → branded name. Light/dark + RTL (page-level
EN/AR switch + theme toggle), axe-checked.

## Demo data

`pnpm --filter @hrm/api run seed:demo` (extended) gives `acme-demo`:
`manager@`, `employee@`, `doha.hr@` (HR_MANAGER limited to the Doha branch),
`former.staff@` (deactivated) — all `DemoPass-123!` — and `newhire@` with
`mustChangePassword=true` and temp password `Temp-Pass-123!` (re-running
re-arms it).

## Honest gaps / decisions

- Users are **not auto-linked to an Employee** on create (an Employee↔User
  link is a separate, existing relationship); linking at creation is a natural
  follow-up.
- No outbound email of the temp password — by design HR hands it over (the
  brief); an emailed-invite variant would be a new, different trust model.
- "Last admin" keys off the system `TENANT_ADMIN` role by name; a tenant that
  renamed/stripped that role would weaken the guard (the escalation guard
  still stands).
- Temp passwords don't expire; regenerate to invalidate. A TTL would be a
  small additive column if wanted.
- The privacy text is a template — legal review is required, as stated on the page.
- No mobile UI; `apps/admin` (vendor console) untouched.

## Verification

See the 7.1 entry in [BUILD_LOG.md](../BUILD_LOG.md).
