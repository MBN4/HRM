import type { SsoConfigInput } from '@hrm/shared';

/**
 * The SSO seam this step FINISHES — see
 * `../providers/auth-provider.interface.ts`'s own doc comment, written back
 * in 0.4, naming exactly this. Deliberately a SEPARATE interface/DI-token
 * pair from `AUTH_PROVIDER`/`AuthProvider`, not a second implementation
 * bound to that SAME token: `AuthProvider.validate(tx, tenantId, email,
 * password)` is shaped for password credentials checked synchronously
 * against one tenant's user table — an assertion/token-based federated
 * login is a fundamentally different, multi-request flow (redirect out,
 * redirect back, exchange a code, verify a signed assertion) with no
 * password to check. `AUTH_PROVIDER`/`LocalAuthProvider` are UNCHANGED by
 * this step — password login still goes through exactly the same path it
 * always has. `SsoService` (not `AuthService`) orchestrates this flow and,
 * once an identity is established, calls the SAME `TokenService.
 * signAccessToken`/`.issueRefreshToken` `AuthService.login` uses, so a
 * client receives an indistinguishable session either way.
 */
export interface SsoIdentity {
  email: string;
  externalId: string;
  displayName?: string;
}

export interface SsoAuthProvider {
  readonly protocol: 'OIDC' | 'SAML';

  /** Builds the URL the browser is redirected to at the IdP, embedding `state` (CSRF/replay protection, generated + tracked by `SsoService`). */
  buildAuthorizationUrl(config: SsoConfigInput, callbackUrl: string, state: string): Promise<string> | string;

  /** Parses the IdP's response (query params for OIDC, form body for SAML) into a verified identity. `callbackUrl` must match what was sent in `buildAuthorizationUrl` (OIDC's `redirect_uri` must match exactly). */
  handleCallback(config: SsoConfigInput, callbackUrl: string, params: Record<string, string>): Promise<SsoIdentity>;
}

export const OIDC_AUTH_PROVIDER = Symbol('OIDC_AUTH_PROVIDER');
export const SAML_AUTH_PROVIDER = Symbol('SAML_AUTH_PROVIDER');
