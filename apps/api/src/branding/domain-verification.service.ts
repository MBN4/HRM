import { Injectable, Logger } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';

/** `_hrm-verify.<domain>` is expected to hold a TXT record of `hrm-verify=<token>`. */
export function verificationRecordName(domain: string): string {
  return `_hrm-verify.${domain}`;
}

export function verificationRecordValue(token: string): string {
  return `hrm-verify=${token}`;
}

export function generateVerificationToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Domain-ownership verification for branded custom domains — step 4.3, see
 * docs/conventions/white-label.md. Uses only Node's built-in `dns/promises`
 * (no extra dependency), the same "no extra dependency" posture 0.9's
 * timezone rendering and 3.3's OIDC JWKS verification already take.
 *
 * A real DNS TXT lookup needs outbound network resolution this sandboxed
 * dev/CI environment may not have — `PlatformBrandingController` also
 * exposes a manual `approve` action (a loudly-audited override, never a
 * silent bypass) for the same reason 4.1's impersonation flow and 4.2's
 * billing flow both document a mock/manual fallback where a real external
 * dependency can't be exercised end-to-end in this environment. This
 * service's `verify()` is still the real, intended production path.
 */
@Injectable()
export class DomainVerificationService {
  private readonly logger = new Logger(DomainVerificationService.name);

  async verify(domain: string, expectedToken: string): Promise<boolean> {
    const recordName = verificationRecordName(domain);
    const expectedValue = verificationRecordValue(expectedToken);
    try {
      const records = await resolveTxt(recordName);
      return records.some((chunks) => chunks.join('').trim() === expectedValue);
    } catch (error) {
      this.logger.warn(`DNS TXT lookup for "${recordName}" failed or found no matching record: ${String(error)}`);
      return false;
    }
  }
}
