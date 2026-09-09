import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HashingService } from '../common/hashing/hashing.service';
import { SIGNING_TOKEN_PREFIX_LENGTH } from './esignature.constants';

/**
 * External signing-link tokens — the SAME indexed-prefix + argon2id-hash
 * pattern `ApiKeyService`/`ApiKeyAuthService` already establish for a
 * presented-secret lookup (step 3.3), applied here to a per-SIGNER,
 * single-DOCUMENT-scoped capability token instead of a tenant-wide API key.
 * The raw token is generated ONCE (at `send()` time) and handed back to the
 * caller so it can build the emailed link — it is never stored; only its
 * hash is, so this service (like the DB) can never reconstruct it again,
 * only `verify()` can check a later presentation against it.
 *
 * Deliberately NOT an authentication mechanism (no JWT, no RBAC context) —
 * it is a scoped CAPABILITY: presenting a valid token grants access to
 * exactly the one `SignatureSigner` row it was minted for, nothing else in
 * the tenant. This is what keeps a leaked link from becoming a general
 * account-takeover vector the way a stolen JWT would be.
 */
@Injectable()
export class SigningTokenService {
  constructor(private readonly hashing: HashingService) {}

  async generate(): Promise<{ rawToken: string; prefix: string; hash: string }> {
    const rawToken = `sig_${randomBytes(24).toString('base64url')}`;
    const prefix = rawToken.slice(0, SIGNING_TOKEN_PREFIX_LENGTH);
    const hash = await this.hashing.hash(rawToken);
    return { rawToken, prefix, hash };
  }

  extractPrefix(rawToken: string): string | null {
    if (!rawToken || rawToken.length < SIGNING_TOKEN_PREFIX_LENGTH) {
      return null;
    }
    return rawToken.slice(0, SIGNING_TOKEN_PREFIX_LENGTH);
  }

  verify(storedHash: string, rawToken: string): Promise<boolean> {
    return this.hashing.verify(storedHash, rawToken);
  }
}
