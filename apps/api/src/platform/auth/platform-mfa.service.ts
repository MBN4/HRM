import { Injectable } from '@nestjs/common';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { buildOtpAuthUrl, generateBase32Secret, generateRecoveryCodes, verifyTotp } from './totp.util';

const OTP_ISSUER = 'HRM Platform';

/**
 * MFA is MANDATORY for every platform admin — this service is the ONLY
 * place TOTP secrets/recovery codes are generated, encrypted, or checked.
 * See docs/conventions/vendor-console.md → Mandatory MFA.
 */
@Injectable()
export class PlatformMfaService {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly hashing: HashingService,
  ) {}

  generateEnrollment(email: string): { secret: string; otpauthUrl: string; encryptedSecret: string } {
    const secret = generateBase32Secret();
    return {
      secret,
      otpauthUrl: buildOtpAuthUrl({ secret, accountEmail: email, issuer: OTP_ISSUER }),
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
      // eslint-disable-next-line no-await-in-loop -- a handful of codes at most; each candidate must be checked in constant-ish time via argon2's own verify, no benefit to parallelizing a short-circuiting search
      if (await this.hashing.verify(hashed, code)) {
        return hashedCodes.filter((h) => h !== hashed);
      }
    }
    return null;
  }
}
