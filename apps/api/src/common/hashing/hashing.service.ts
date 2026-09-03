import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// See apps/api/src/auth/password.service.ts for why this is pinned to the
// literal `2` rather than the library's own `Algorithm.Argon2id` const enum.
const ARGON2ID = 2;

/**
 * One-way hashing, generalized out of `apps/api/src/auth/password.service.ts`
 * (step 3.3) so credential hashing outside the auth module — API keys
 * (`ApiKeyService`), biometric device secrets (`BiometricDeviceService`) —
 * doesn't need to reach into `AuthModule`'s internals (which doesn't export
 * `PasswordService`) or hand-roll a second hashing scheme. Identical
 * algorithm/parameters to `PasswordService` — this is the SAME primitive,
 * just made reusable, not a new one. `@Global()` (see `hashing.module.ts`),
 * matching `EncryptionService`'s own "general-purpose primitive, reused
 * everywhere" posture.
 *
 * Deliberately NOT used for webhook signing secrets / SSO client secrets —
 * those must be DECRYPTABLE (the app needs the original value again to sign
 * a delivery or call a token endpoint), so they go through the reversible
 * `EncryptionService` instead. This service is only for values checked by
 * comparison and never needed back in plaintext.
 */
@Injectable()
export class HashingService {
  hash(plain: string): Promise<string> {
    return hash(plain, { algorithm: ARGON2ID });
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    return verify(hashed, plain);
  }
}
