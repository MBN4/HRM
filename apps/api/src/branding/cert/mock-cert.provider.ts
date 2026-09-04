import { Injectable } from '@nestjs/common';
import type { CertProvider, CertProvisionResult } from './cert-provider.interface';

const CERT_LIFETIME_DAYS = 90;

/**
 * The dev/no-live-ACME-account CERT_PROVIDER binding — no real Certificate
 * Authority account exists in this environment (same reason 4.2's
 * `MockStripeClient` exists), so this deterministically "issues" a
 * certificate immediately with a realistic ~90-day lifetime (Let's
 * Encrypt's own real-world default) instead of calling out to anything.
 * Bound whenever `ACME_ENABLED` is unset — see branding.module.ts and
 * `AcmeCertProvider`'s own doc comment for the real seam.
 */
@Injectable()
export class MockCertProvider implements CertProvider {
  provisionCertificate(_domain: string): Promise<CertProvisionResult> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CERT_LIFETIME_DAYS);
    return Promise.resolve({ status: 'ISSUED', expiresAt });
  }
}
