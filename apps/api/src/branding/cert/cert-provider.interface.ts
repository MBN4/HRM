export const CERT_PROVIDER = Symbol('CERT_PROVIDER');

export interface CertProvisionResult {
  status: 'ISSUED' | 'PENDING' | 'FAILED';
  expiresAt?: Date;
}

/**
 * The TLS-certificate provisioning seam for branded custom domains — see
 * docs/conventions/white-label.md. Same bind-an-interface-to-a-DI-token
 * shape as `AUTH_PROVIDER` (0.4)/`STRIPE_CLIENT` (4.2): callers
 * (`PlatformBrandingService`) depend on this interface only, never a
 * concrete implementation.
 */
export interface CertProvider {
  /** Requires the domain to already be VERIFIED (ownership proven) — the caller enforces that ordering, not this interface. */
  provisionCertificate(domain: string): Promise<CertProvisionResult>;
}
