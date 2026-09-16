import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { HashingService } from '../../common/hashing/hashing.service';
// Reuses the EXACT RFC 4226/6238 implementation `PlatformMfaService` (step
// 4.1) already established for platform admins' MANDATORY MFA — no second
// TOTP algorithm, no otplib/speakeasy dependency, per this step's own
// brief. See that file's doc comment for why this is dependency-free.
import { buildOtpAuthUrl, generateBase32Secret, generateRecoveryCodes, verifyTotp } from '../../platform/auth/totp.util';

/**
 * The tenant-user counterpart to `PlatformMfaService` — same shape
 * (generate an enrollment secret, verify a code, issue/consume one-time
 * recovery codes), applied to a SEPARATE identity space (`User`, not
 * `PlatformAdmin`), the same "platform vs. tenant get their own auth
 * service even though they share primitives" split `AuthService`/
 * `PlatformAuthService` and `TokenService`/`PlatformTokenService` already
 * establish. Unlike platform MFA, tenant MFA is OPTIONAL — enforced by
 * `AuthService.login`/`AuthController`'s MFA routes, never by a DB
 * constraint (see `User.mfaEnabled`'s own doc comment in schema.prisma).
 */
@Injectable()
export class TenantMfaService {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly hashing: HashingService,
    private readonly config: ConfigService,
  ) {}

  generateEnrollment(email: string): { secret: string; otpauthUrl: string; encryptedSecret: string } {
    const issuer = this.config.get<string>('TENANT_MFA_ISSUER') ?? 'HRM';
    const secret = generateBase32Secret();
    return {
      secret,
      otpauthUrl: buildOtpAuthUrl({ secret, accountEmail: email, issuer }),
      encryptedSecret: this.encryption.encrypt(secret),
    };
  }

  verifyCode(encryptedSecret: string, code: string): boolean {
    const secret = this.encryption.decrypt(encryptedSecret);
    return verifyTotp(secret, code);
  }

  generateRecoveryCodes(): string[] {
    return generateRecoveryCodes();
  }

  hashRecoveryCodes(codes: string[]): Promise<string[]> {
    return Promise.all(codes.map((code) => this.hashing.hash(code)));
  }

  /** Returns the remaining hashed codes (with the matched one consumed) on success, or `null` if `code` matched none. */
  async verifyAndConsumeRecoveryCode(hashedCodes: string[], code: string): Promise<string[] | null> {
    for (const hashed of hashedCodes) {
      // eslint-disable-next-line no-await-in-loop -- a handful of codes at most; each candidate must be checked via argon2's own verify, no benefit to parallelizing a short-circuiting search — same reasoning PlatformMfaService documents for itself
      if (await this.hashing.verify(hashed, code)) {
        return hashedCodes.filter((h) => h !== hashed);
      }
    }
    return null;
  }
}
