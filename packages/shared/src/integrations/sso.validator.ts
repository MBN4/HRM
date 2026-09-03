import { z } from 'zod';

/**
 * Per-tenant SSO configuration — step 3.3, finishing the seam abstracted
 * since 0.4 (see `apps/api/src/auth/providers/auth-provider.interface.ts`).
 * A protocol-discriminated union, the SAME "JSON column has no schema-level
 * guarantee of its own, re-validated on read/write" posture every other
 * JSON-configured feature in this codebase already takes (CountryPackConfig,
 * WorkflowStep.approverRule, ...).
 *
 * `clientSecret` (OIDC) is accepted here in PLAINTEXT at the DTO layer (an
 * admin typing it in) — the SERVICE layer (`SsoConfigService`) encrypts it
 * with `EncryptionService` before the row is ever written, and a read-back
 * of an existing config never returns the decrypted secret (write-only,
 * same "shown/accepted once" posture `ApiKey.hashedKey` takes for its raw
 * key, though this one is genuinely reversible since the app must decrypt
 * it again to call the token endpoint).
 */
export const oidcSsoConfigSchema = z.object({
  protocol: z.literal('OIDC'),
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  jwksUri: z.string().url(),
  scopes: z.array(z.string()).min(1).default(['openid', 'email', 'profile']),
  defaultRoleName: z.string().min(1),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
});
export type OidcSsoConfigInput = z.infer<typeof oidcSsoConfigSchema>;

/**
 * SAML — see docs/conventions/integrations.md's HONEST LIMITATION note:
 * this reference implementation builds a real SP-initiated AuthnRequest
 * (redirect binding) but does NOT verify the IdP response's XML signature
 * (`SamlAuthProvider.handleCallback` throws `NotImplementedException`) — a
 * certified XML-DSig verifier is real, non-trivial cryptographic surface
 * area (canonicalization, signature-wrapping-attack resistance) this step
 * deliberately does not attempt to hand-roll. `idpCertificate` is captured
 * now so a real verifier is a config-compatible drop-in later, exactly like
 * bank export's single-CSV-format gap.
 */
export const samlSsoConfigSchema = z.object({
  protocol: z.literal('SAML'),
  idpEntityId: z.string().min(1),
  idpSsoUrl: z.string().url(),
  idpCertificate: z.string().min(1),
  spEntityId: z.string().min(1),
  defaultRoleName: z.string().min(1),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
});
export type SamlSsoConfigInput = z.infer<typeof samlSsoConfigSchema>;

export const ssoConfigInputSchema = z.discriminatedUnion('protocol', [oidcSsoConfigSchema, samlSsoConfigSchema]);
export type SsoConfigInput = z.infer<typeof ssoConfigInputSchema>;

export const updateSsoConfigEnabledSchema = z.object({ enabled: z.boolean() });
