import { Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CertProvider, CertProvisionResult } from './cert-provider.interface';

/**
 * The REAL ACME (e.g. Let's Encrypt) integration seam — deliberately NOT
 * implemented against a live directory in this step, per this step's own
 * brief ("full cert automation may depend on deploy env, so a clear seam +
 * local story is fine"). Real ACME issuance needs infrastructure this
 * sandboxed dev/CI environment cannot provide either way: a publicly
 * resolvable domain plus a reachable HTTP-01 (a challenge file served at
 * `http://<domain>/.well-known/acme-challenge/...`) or DNS-01 (a
 * `_acme-challenge` TXT record this app would need write access to
 * provision) challenge responder — neither exists here, unlike Stripe
 * (4.2), where a real SDK could at least be wired even without a live
 * account to test against.
 *
 * A real implementation would use a library such as `acme-client` against
 * `ACME_DIRECTORY_URL` (Let's Encrypt's production or staging directory)
 * with an account keyed by `ACME_ACCOUNT_EMAIL`, complete the chosen
 * challenge type, and return the issued certificate/expiry — swapping
 * `CERT_PROVIDER`'s binding in `branding.module.ts` from `MockCertProvider`
 * to this class (bound only when `ACME_ENABLED=true`, never set in this
 * repo) is the entire integration point; `PlatformBrandingService` needs no
 * change either way, the same "swap one DI binding, no caller changes"
 * seam shape 0.4's `AUTH_PROVIDER`/0.8's notification providers already
 * establish.
 */
@Injectable()
export class AcmeCertProvider implements CertProvider {
  constructor(private readonly config: ConfigService) {}

  provisionCertificate(_domain: string): Promise<CertProvisionResult> {
    const directoryUrl = this.config.get<string>('ACME_DIRECTORY_URL');
    throw new NotImplementedException(
      `Real ACME certificate provisioning is a documented seam, not implemented in this environment (ACME_DIRECTORY_URL=${directoryUrl ?? '(unset)'}). See apps/api/src/branding/cert/acme-cert.provider.ts.`,
    );
  }
}
