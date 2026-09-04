# Tenant resolution

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.3 — `apps/api/src/tenancy`. See
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "0.3 tenant resolution" entry)
for the full file list and verification notes. Builds directly on
[tenancy-rls.md](./tenancy-rls.md).

- `TenantResolutionService` tries strategies **in order** until one
  matches, configurable via `TENANT_RESOLUTION_STRATEGIES` (comma list;
  default `subdomain,custom_domain,header`):
  1. **subdomain** — `acme.<TENANT_BASE_DOMAIN>` → `Tenant.slug = "acme"`.
     Disabled entirely if `TENANT_BASE_DOMAIN` is unset. Only a single
     label is matched (`acme`, not `acme.eu`) — a stray dot skips this
     strategy rather than guessing.
  2. **custom_domain** — exact `Host` header match against
     `TenantDomain.domain` (see [tenancy-rls.md](./tenancy-rls.md) →
     `TenantDomain`), AND (since step 4.3 — see
     [white-label.md](./white-label.md)) `verificationStatus ===
'VERIFIED'` — a freshly-requested, not-yet-ownership-proven domain
     never matches here.
  3. **header** — `TENANT_HEADER_NAME` (default `x-tenant-id`) carrying
     either the tenant's UUID `id` or its `slug`, for mobile/API clients
     with no per-tenant hostname.
- All three query `appPrisma` **directly**, with no `withTenantContext` —
  `tenants` and `tenant_domains` are both RLS-exempt (see
  [tenancy-rls.md](./tenancy-rls.md)), precisely so resolution can run
  before a tenant context exists to open one with.
- Unresolvable → `401 Unauthorized`. Routes marked `@Public()` (health
  checks, and eventually login) skip resolution entirely — no tenant, no
  transaction, and `@CurrentTenant()`/`TenantContextService.getTx()` won't
  work there. `TENANT_STATUS` (suspended/cancelled tenants) is
  deliberately **not** checked here — that's a licensing/billing concern
  for step 0.6 (see
  [licensing-feature-flags.md](./licensing-feature-flags.md)), not "can we
  find this tenant."
- **The whole rest of the request runs inside one transaction.**
  `TenantScopeInterceptor` (a global `APP_INTERCEPTOR`) resolves the
  tenant, then wraps everything downstream — remaining interceptors,
  pipes, the controller method — in a single `withTenantContext` call, so
  every query the handler makes is RLS-enforced, not just ones a
  developer remembers to wrap. The Observable from `next.handle()` is
  bridged into the transaction's callback via `firstValueFrom` (awaiting
  the Observable directly would resolve instantly with the Observable
  object itself, closing the transaction before the controller ever
  runs).
  **Known tradeoff**: this holds one pooled Postgres connection open for
  the full duration of every non-public request, including any slow I/O
  the handler does. Deliberate, per this step's brief ("RLS enforced for
  the whole request lifecycle") — addressed directly in step 0.10, see
  [resilience.md](./resilience.md) → Connection-pool protection.
- **Request context propagation is via `AsyncLocalStorage`, not
  REQUEST-scoped DI.** `tenant-context.store.ts` exports the raw
  `AsyncLocalStorage<RequestTenantStore>`; `TenantContextService`
  (injectable) and `@CurrentTenant()` (param decorator) both read from it.
  Chosen over Nest's REQUEST scope because REQUEST-scoped providers
  rebuild the whole DI subtree per request — real overhead this avoids —
  and because a decorator can't receive constructor-injected dependencies
  anyway. `RequestTenantStore` is per-in-flight-request, never shared or
  persisted, so it adds no cross-instance state (consistent with the
  STATELESS requirement — anything that must survive or be shared across
  requests belongs in Redis, not here).
- **Context shape**: `{ tenantId, branchId, userId, roles, platform }`.
  Only `tenantId`/`platform` are populated as of this step; `branchId`/
  `userId`/`roles` are wired through and typed but stay `null` until auth
  (0.4, see [auth-rbac.md](./auth-rbac.md)) populates them — don't add new
  ad hoc "current user" plumbing later, extend this store instead.
- **Platform (no-tenant) context — stub only as of this step.**
  `@PlatformRoute()` marks a route for the future vendor super-admin
  surface. It is rejected (`403`) unless `PLATFORM_MODE_ENABLED=true` (off
  by default), and even then `TenantScopeInterceptor` opens **no
  transaction** for it — `TenantContextService.getTx()` throws
  unconditionally on a platform request. There is no working tenant-data
  bypass at this step, by construction: this step only wires the seam
  (decorator + config flag + rejection path) so real RBAC- and
  audit-gated cross-tenant access has somewhere to attach later, without
  ever weakening a normal tenant request (a route without
  `@PlatformRoute()` is entirely unaffected by the flag). The first real
  use of this seam is 0.6's licensing admin routes — see
  [licensing-feature-flags.md](./licensing-feature-flags.md) → Platform
  context.
- Verified end-to-end over real HTTP (not just at the `withTenantContext`
  helper level) by `apps/api/test/tenant-resolution.e2e-spec.ts`: subdomain
  and header resolution both isolate tenant A from tenant B, a crafted
  `?tenantId=B` query param on a tenant-A-scoped request returns zero rows
  (RLS, not application code, is what blocks it), an unresolvable tenant
  gets `401`, `/health` works with no tenant, and a platform route is
  rejected while disabled.
