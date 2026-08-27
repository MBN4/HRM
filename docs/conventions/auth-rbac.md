# Auth / RBAC model

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.4 — `apps/api/src/auth`, `apps/api/src/common/permissions`,
`apps/api/src/tenancy`. See [`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "0.4
auth + RBAC" entry) for the full file list and verification notes. For the
declarative field-gating mechanism built on top of this, see
[field-level-permissions.md](./field-level-permissions.md). Builds directly
on [tenant-resolution.md](./tenant-resolution.md).

- **Where auth-context population actually lives.** `TenantScopeInterceptor`
  (0.3) was EXTENDED, not replaced: after it resolves the tenant and opens
  the transaction, and unless the route is `@AllowAnonymous()`, it also
  verifies the request's `Authorization: Bearer` JWT and loads the user's
  current roles/permissions/branch-scope — through the SAME transaction,
  since `User`/`Role`/`Permission`/`UserBranch` are all RLS-protected.
  This was deliberate, not an accident of convenience: `tx` only exists
  inside that interceptor's call; a second global interceptor for auth
  would make "does it see `tx`" an implicit property of module import
  order rather than a guarantee (this exact failure mode later hit 0.10's
  load shedding/timeout work for real — see [resilience.md](./resilience.md)
  → "THE SPINE IS ONE INTERCEPTOR"). `RequestTenantStore` gained two fields
  for this: `permissions: string[] | null` and `branchIds: string[] | null`
  (see Branch scoping below) — exactly the extension 0.3 invited.
- **Two-token model.** Access tokens are short-lived, stateless JWTs
  (`@nestjs/jwt`, `JWT_SECRET`/`JWT_EXPIRES_IN`) carrying only
  `{ sub: userId, tenantId }` — deliberately NOT roles/permissions, so a
  permission/role change takes effect on the very next request instead of
  waiting out the token's TTL; `TenantScopeInterceptor` loads them fresh
  from the DB every time instead. Refresh tokens are opaque random ids
  tracked in Redis (`TokenService`, `JWT_REFRESH_EXPIRES_IN`), one record
  per token at `auth:rt:<tokenId>`, because they need to be individually
  revocable and rotation-tracked — a JWT refresh token would just be a
  stateless wrapper around state we have to keep in Redis anyway.
- **Refresh rotation + reuse detection.** Every refresh both invalidates
  the presented token and issues a new one in the same "family"
  (`auth:family:<familyId>`, one per login/session). A rotated-away
  token's record isn't deleted — it's flagged `used: true` and kept until
  its original TTL lapses, as a tombstone. Presenting it again (the
  signature of a leaked/stolen refresh token — a legitimate client would
  never do this) revokes the ENTIRE family, not just that token, and
  emits `auth.refresh_reuse_detected`. A token with no record at all
  (never issued, or already fully expired/revoked) is just an ordinary
  401, not a reuse signal. `logout` revokes one family (the session tied
  to the presented refresh token); `logout-all` revokes every family for
  the user (`auth:userfamilies:<tenantId>:<userId>`).
- **`@AllowAnonymous()` vs `@Public()`** — two different decorators for
  two different exemptions, both in the pipeline above:
  `@Public()` (0.3) skips tenant resolution entirely (health checks —
  there's no tenant to bind to). `@AllowAnonymous()` (0.4) still resolves
  the tenant and opens its transaction, it just skips the JWT check —
  login/refresh/request-password-reset/reset-password need a tenant to
  scope the user lookup to, they just don't have a token yet (that's what
  they're for).
- **RBAC is deny-by-default, DB-backed, not enum-backed.** `Role` and
  `Permission` are ordinary tenant-scoped tables (RLS applies to both,
  same pattern as every other 0.2 table — see [tenancy-rls.md](./tenancy-rls.md))
  — `packages/shared`'s `PERMISSIONS`/`SYSTEM_ROLE_PERMISSIONS` constants
  are ONLY seed defaults (`packages/db/src/seed-rbac.ts`'s
  `seedSystemRolesAndPermissions`, called by `prisma/seed.ts` for the demo
  tenant), never read at enforcement time — a tenant can rename a role or
  edit its permission set with zero code change, and it takes effect on
  the next request. Seeded system roles: `TENANT_ADMIN` (all permissions),
  `HR_MANAGER`, `MANAGER`, `EMPLOYEE` (see the constants for exact
  defaults).
- **`@RequirePermissions(...)` + `PermissionsGuard` — actually an
  interceptor.** Deny-by-default: missing any listed permission -> 403.
  Despite the name and `@RequirePermissions()`/`PermissionsGuard` pairing
  matching what a `CanActivate` guard would look like, `PermissionsGuard`
  implements `NestInterceptor` and is applied via
  `@UseInterceptors(PermissionsGuard)`. This is required, not stylistic:
  Nest runs ALL guards — global or route-scoped — strictly before ANY
  interceptor, with no exception, and the permission set this checks is
  loaded by `TenantScopeInterceptor` during the interceptor phase. A real
  `CanActivate` here would always see an empty permission set and always
  reject. Reference usage: `GET /auth/rbac-demo` (`role.manage`). This
  exact "decorator carries metadata, route-scoped interceptor does the
  work" shape is reused throughout the codebase — `@RequireFeature()` +
  `FeatureFlagGuard` (0.6), `@AuditLog()` + `AuditInterceptor` (0.9),
  `@Idempotent()` + `IdempotencyInterceptor` (0.10) — for the same
  ordering reason.
- **Branch scoping** extends the same mechanism: a user with zero
  `UserBranch` rows is unrestricted (every branch in the tenant, as
  always); one or more rows limits them to exactly those. RLS has no
  per-branch concept — enforcement is an application-level filter using
  the request context's `branchIds`, layered ON TOP of tenant RLS, applied
  per-query by the handler (reference: `GET /tenancy/branches`, which
  narrows `where.id` to `branchIds` when the caller is restricted).
  `branchId` (singular) stays in the context too, as the user's first
  allowed branch, for convenience — `branchIds` is what enforcement
  should read. This two-layer shape (an RBAC permission gates the
  FEATURE, a service-layer row-level check gates WHICH rows) is reused by
  0.7's workflow engine — see [workflow.md](./workflow.md) → Two
  authorization layers.
- **SSO seam (seam only — no real SSO yet).** `AuthService` depends on
  the `AUTH_PROVIDER` DI token (`apps/api/src/auth/providers/auth-provider.interface.ts`),
  not on a concrete implementation. `LocalAuthProvider` (email + password
  via argon2id, `@node-rs/argon2` — prebuilt native bindings, no
  node-gyp) is the only binding today
  (`{ provide: AUTH_PROVIDER, useExisting: LocalAuthProvider }` in
  `auth.module.ts`). Adding SAML/OIDC later means adding a new
  `AuthProvider` implementation and changing that one binding (eventually
  to a per-tenant-configurable selector) — `AuthService` itself shouldn't
  need to change. This "swap one DI binding, no caller changes" seam
  pattern is reused by 0.8's notification providers — see
  [notifications-queues.md](./notifications-queues.md) → Provider seam.
- **Audit-event emission points (wiring for 0.9, superseded by real
  persistence — see [audit-custom-fields.md](./audit-custom-fields.md)).**
  `AuthService`/`TokenService` emit structured `auth.*` domain events via
  `@nestjs/event-emitter` for every auth-worthy action: `auth.login`,
  `auth.login_failed`, `auth.logout`, `auth.logout_all`,
  `auth.password_changed`, `auth.password_reset_requested`,
  `auth.password_reset_completed`, `auth.refresh_reuse_detected` (see
  `apps/api/src/auth/auth-events.ts` for the full contract). As of this
  step, consumed only by `AuditEventsListener`, which just
  structured-logs them — 0.9 replaces that listener with real persistence
  into the (partitioned, see [tenancy-rls.md](./tenancy-rls.md)) `audit_log`
  table without touching `AuthService`, and 0.8's notification hub also
  subscribes to these same events (see
  [notifications-queues.md](./notifications-queues.md)). Role-change
  events are intentionally NOT wired yet: this step has no
  role-management endpoint (only enforcement + seeding), so there's
  nothing real to emit from — added when that endpoint lands.
- **Security baseline**: all request bodies validated via zod schemas
  from `packages/shared` through a small `ZodValidationPipe` (the
  project's one validation paradigm end to end, not a second one
  alongside class-validator); login/refresh/reset all give the same
  generic failure message regardless of _why_ (unknown email, wrong
  password, inactive account, expired/invalid token) — no user
  enumeration; login/refresh/password-reset-request are Redis-rate-limited
  per `{tenantId, email}` (`RateLimiterService`, fixed-window `INCR`+`EXPIRE`),
  reset to zero on a successful login so legitimate rapid use isn't
  penalized by attempts that came before it succeeded; no secrets appear
  in code (JWT/DB/Redis secrets are all env-sourced, per existing
  convention).
- Verified end-to-end over real HTTP by `apps/api/test/auth-rbac.e2e-spec.ts`
  (16 tests: login incl. no-enumeration, refresh rotation + reuse
  revoking the whole family, logout vs. logout-all, RBAC permit/deny,
  field-level include/omit, branch-scoping restricted/unrestricted,
  cross-tenant login rejection + cross-tenant token replay rejection +
  RLS still holding, rate-limit 429) plus `apps/api/test/tenant-resolution.e2e-spec.ts`
  (0.3's suite, updated to authenticate now that `/tenancy/*` correctly
  requires it).
