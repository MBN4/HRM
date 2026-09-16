import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENCRYPTION_KEY_PROVIDER, type EncryptionKeyProvider } from './key-provider/encryption-key-provider.interface';

const ALGORITHM = 'aes-256-gcm';
// GCM's recommended IV length — see Node's crypto docs; a shorter or longer
// IV both work mechanically but 12 bytes is what every reference GCM usage
// (including Node's own tests) standardizes on.
const IV_LENGTH_BYTES = 12;

/**
 * Application-level field encryption (AES-256-GCM) for data that must be
 * ENCRYPTED AT REST — Employee bank details and compensation today (see
 * docs/conventions/employee.md), any future PII-adjacent field later.
 *
 * This is a SEPARATE, independent control from the field-level permission
 * pattern (`@RequiresPermission()`/`PermissionSerializerInterceptor`) that
 * gates whether a decrypted value ever reaches an API response at all — one
 * protects the DATABASE COLUMN, the other protects the API RESPONSE, and
 * both apply to `Employee.baseSalaryEncrypted` simultaneously. Consistent
 * with this project's "no single layer of security is trusted alone"
 * posture (see docs/conventions/tenancy-rls.md).
 *
 * Ciphertext is stored as `v<version>:<iv>:<authTag>:<data>`, each part
 * base64-encoded — a fresh random IV per encryption call (GCM must never
 * reuse an IV under the same key) and the GCM authentication tag alongside
 * it, so `decrypt` can both decrypt AND verify integrity (tampering raises
 * rather than silently returning garbage).
 *
 * **Key rotation (step 6.2).** Key material comes from an injected
 * `EncryptionKeyProvider` (see key-provider/), not `ConfigService` directly
 * — see that interface's doc comment for the secrets-manager seam this
 * unlocks. `encrypt()` always writes under the provider's CURRENT version;
 * `decrypt()` reads the version prefix and looks up the matching key,
 * including retired ("previous") versions the provider still returns, so
 * rotating away from an old key does not break any value encrypted under
 * it. Ciphertext with NO `vN:` prefix — every value written before this
 * step existed — is treated as version `"1"`, the implicit version every
 * deployment starts on; rotating away from the ORIGINAL key means moving it
 * into `FIELD_ENCRYPTION_PREVIOUS_KEYS` as `1:<that key>` so this
 * unprefixed legacy format keeps decrypting. This is what makes rotation
 * fully additive/backward-compatible: every pre-6.2 encrypted column value
 * in the database decrypts correctly with zero migration.
 */
@Injectable()
export class EncryptionService {
  private readonly currentVersion: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(@Inject(ENCRYPTION_KEY_PROVIDER) provider: EncryptionKeyProvider) {
    const { currentVersion, keys } = provider.getKeys();
    if (!keys.has(currentVersion)) {
      throw new Error(`EncryptionKeyProvider did not return a key for its own declared currentVersion "${currentVersion}".`);
    }
    this.currentVersion = currentVersion;
    this.keys = keys;
  }

  encrypt(plaintext: string): string {
    const key = this.requireKey(this.currentVersion);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const parts = [iv, authTag, ciphertext].map((buf) => buf.toString('base64'));
    return [`v${this.currentVersion}`, ...parts].join(':');
  }

  decrypt(stored: string): string {
    const { version, ivB64, authTagB64, dataB64 } = this.parse(stored);
    const key = this.requireKey(version);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  /** `null` in, `null` out — convenience for optional DB columns so callers don't have to null-check around every call. */
  encryptOptional(plaintext: string | null | undefined): string | null {
    return plaintext === null || plaintext === undefined ? null : this.encrypt(plaintext);
  }

  decryptOptional(stored: string | null | undefined): string | null {
    return stored === null || stored === undefined ? null : this.decrypt(stored);
  }

  private parse(stored: string): { version: string; ivB64: string; authTagB64: string; dataB64: string } {
    const segments = stored.split(':');
    // Versioned format (step 6.2 onward): "v<version>:<iv>:<authTag>:<data>".
    if (segments.length === 4 && segments[0].startsWith('v')) {
      const [versionSegment, ivB64, authTagB64, dataB64] = segments;
      return { version: versionSegment.slice(1), ivB64, authTagB64, dataB64 };
    }
    // Legacy, pre-6.2 format: "<iv>:<authTag>:<data>", always encrypted
    // under the implicit first key version, "1".
    if (segments.length === 3) {
      const [ivB64, authTagB64, dataB64] = segments;
      return { version: '1', ivB64, authTagB64, dataB64 };
    }
    throw new Error('Malformed encrypted field value (expected "v<version>:<iv>:<authTag>:<data>" or the legacy "<iv>:<authTag>:<data>").');
  }

  private requireKey(version: string): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(
        `No field-encryption key available for version "${version}" — if this key was rotated away, add it to FIELD_ENCRYPTION_PREVIOUS_KEYS so existing ciphertext under it can still be decrypted.`,
      );
    }
    return key;
  }
}
