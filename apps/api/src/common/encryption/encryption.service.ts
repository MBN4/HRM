import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
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
 * Ciphertext is stored as `<iv>:<authTag>:<data>`, each base64-encoded — a
 * fresh random IV per encryption call (GCM must never reuse an IV under the
 * same key) and the GCM authentication tag alongside it, so `decrypt` can
 * both decrypt AND verify integrity (tampering raises rather than silently
 * returning garbage). The key itself (`FIELD_ENCRYPTION_KEY`, a
 * base64-encoded 32-byte value) is read once at construction — a
 * misconfigured/missing key fails loudly at startup, the same "no
 * `missing_ok`" posture RLS's `current_setting` and Country Pack resolution
 * already hold themselves to, rather than failing confusingly on the first
 * write.
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('FIELD_ENCRYPTION_KEY');
    if (!raw) {
      throw new Error('FIELD_ENCRYPTION_KEY is not set.');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        `FIELD_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (a base64-encoded AES-256 key); got ${key.length}.`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join(':');
  }

  decrypt(stored: string): string {
    const [ivB64, authTagB64, dataB64] = stored.split(':');
    if (!ivB64 || !authTagB64 || !dataB64) {
      throw new Error('Malformed encrypted field value (expected "<iv>:<authTag>:<data>").');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
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
}
