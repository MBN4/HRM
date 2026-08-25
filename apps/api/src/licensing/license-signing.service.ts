import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { LicensePayload } from '@hrm/shared';

/**
 * Issues signed license files — the ONLY place in this codebase that ever
 * reads the RS256 PRIVATE signing key. See /CLAUDE.md § Conventions →
 * Licensing / feature flags → Lifetime mode for the full key-handling
 * rule: the private key must never be present in an on-prem build. This
 * service enforces that structurally, not just by convention — it reads
 * the key file lazily, only when `sign()` is actually called, so a
 * deployment that simply doesn't have `LICENSE_PRIVATE_KEY_PATH`/the file
 * it points to can still run `LicenseVerificationService` (which only
 * needs the public key) without ever touching this class successfully.
 *
 * Uses `@nestjs/jwt`'s `JwtService` directly (not the app-wide `JwtModule`
 * registration, which is HS256-configured for access tokens) — instantiated
 * plain, with the RS256 private key supplied per call via `sign()`'s
 * `privateKey` option, exactly the pattern this codebase's own e2e tests
 * already use to mint tokens directly (see `apps/api/test/*.e2e-spec.ts`).
 */
@Injectable()
export class LicenseSigningService {
  private readonly jwt = new JwtService();

  constructor(private readonly config: ConfigService) {}

  /** `expiresInDays` omitted = a perpetual license (no `exp` claim at all). */
  sign(payload: LicensePayload, expiresInDays?: number): string {
    const privateKey = this.loadPrivateKey();
    return this.jwt.sign(payload, {
      algorithm: 'RS256',
      privateKey,
      ...(expiresInDays ? { expiresIn: `${expiresInDays}d` } : {}),
    });
  }

  private loadPrivateKey(): string {
    const path = this.config.get<string>('LICENSE_PRIVATE_KEY_PATH');
    if (!path) {
      throw new Error(
        'LICENSE_PRIVATE_KEY_PATH is not set. Issuing a license requires the vendor\'s RS256 ' +
          'private signing key, which must never be present in an on-prem deployment — see ' +
          '/CLAUDE.md § Conventions → Licensing / feature flags.',
      );
    }
    return readFileSync(path, 'utf8');
  }
}
