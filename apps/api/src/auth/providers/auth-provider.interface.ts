import type { Prisma, User } from '@hrm/db';

/**
 * SSO seam: abstracts *how* a set of credentials is validated into a
 * tenant's user, so SAML/OIDC providers can be added later (a per-tenant
 * config choice, e.g. under a future `Tenant.ssoProvider` field) without
 * `AuthService` changing at all. `LocalAuthProvider` — email + password via
 * argon2id — is the only implementation today, bound to the `AUTH_PROVIDER`
 * DI token in `auth.module.ts`.
 *
 * `tx` is always the caller's already-open, RLS-scoped transaction (see
 * TenantScopeInterceptor) — a provider must never open its own connection.
 */
export interface AuthProvider {
  readonly type: string;
  validate(tx: Prisma.TransactionClient, tenantId: string, email: string, password: string): Promise<User | null>;
}
