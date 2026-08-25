import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { LicensePayload, licensePayloadSchema } from '@hrm/shared';

export class InvalidLicenseError extends Error {}

export interface VerifiedLicense {
  payload: LicensePayload;
  /** From the JWT's standard `iat` claim. */
  issuedAt: Date;
  /** From the JWT's standard `exp` claim; `null` = perpetual (no `exp` claim was set at signing). */
  expiresAt: Date | null;
}

/**
 * Verifies a license file's RS256 signature — the ONLY function that
 * decides whether a license file is authentic. Reads ONLY the PUBLIC key
 * (`LICENSE_PUBLIC_KEY_PATH`); never the private one. This is what must
 * work in every deployment, SaaS or on-prem, regardless of whether that
 * deployment could ever issue a license itself.
 *
 * Called on every lifetime-mode entitlement resolution
 * (`FeatureFlagResolutionService`), not just once at activation — this is
 * what satisfies "verify on boot and periodically" from this step's brief
 * without a separate scheduler: every check IS a fresh re-verification
 * against the current public key and the current clock, so a
 * tampered/expired license stops being trusted the moment it's next
 * evaluated, not on some interval.
 */
@Injectable()
export class LicenseVerificationService {
  private readonly jwt = new JwtService();
  private publicKeyCache: string | undefined;

  constructor(private readonly config: ConfigService) {}

  verify(token: string): VerifiedLicense {
    const publicKey = this.loadPublicKey();

    let decoded: unknown;
    try {
      decoded = this.jwt.verify(token, { algorithms: ['RS256'], publicKey });
    } catch (error) {
      throw new InvalidLicenseError(error instanceof Error ? error.message : 'Invalid license file.');
    }

    if (typeof decoded !== 'object' || decoded === null) {
      throw new InvalidLicenseError('License payload is not an object.');
    }
    const claims = decoded as { iat?: number; exp?: number };

    const result = licensePayloadSchema.safeParse(decoded);
    if (!result.success) {
      throw new InvalidLicenseError('License payload does not match the expected shape.');
    }
    if (typeof claims.iat !== 'number') {
      throw new InvalidLicenseError('License is missing a standard "iat" claim.');
    }

    return {
      payload: result.data,
      issuedAt: new Date(claims.iat * 1000),
      expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null,
    };
  }

  private loadPublicKey(): string {
    if (this.publicKeyCache) {
      return this.publicKeyCache;
    }
    const path = this.config.get<string>('LICENSE_PUBLIC_KEY_PATH');
    if (!path) {
      throw new Error('LICENSE_PUBLIC_KEY_PATH is not set — required to verify any license file.');
    }
    this.publicKeyCache = readFileSync(path, 'utf8');
    return this.publicKeyCache;
  }
}
