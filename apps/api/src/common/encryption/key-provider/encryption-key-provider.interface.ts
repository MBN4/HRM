export const ENCRYPTION_KEY_PROVIDER = Symbol('ENCRYPTION_KEY_PROVIDER');

export interface EncryptionKeySet {
  /** Which entry of `keys` new ciphertext is written under (`EncryptionService.encrypt`). */
  currentVersion: string;
  /** version label -> raw 32-byte AES-256 key. Must contain at least `currentVersion`; older versions are kept only for decrypting pre-rotation ciphertext. */
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * The secrets-provider seam for field-encryption keys (step 6.2) — the
 * SAME Symbol-token + interface + swap-one-DI-binding shape as
 * `STRIPE_CLIENT` (billing.md) and `CERT_PROVIDER` (white-label.md).
 * `EncryptionService` depends on this interface only, never on
 * `ConfigService` directly, so where a key actually comes from (env vars
 * today, a real cloud secrets manager later) is entirely this binding's
 * concern — see `encryption.module.ts`.
 */
export interface EncryptionKeyProvider {
  getKeys(): EncryptionKeySet;
}

export const FIELD_ENCRYPTION_KEY_LENGTH_BYTES = 32;

/** Shared by every `EncryptionKeyProvider` implementation that decodes base64 AES-256 keys — kept out of `EncryptionService` itself so the service doesn't need to know keys are base64-encoded at all. */
export function decodeFieldEncryptionKey(raw: string, sourceName: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== FIELD_ENCRYPTION_KEY_LENGTH_BYTES) {
    throw new Error(
      `${sourceName} must decode to exactly ${FIELD_ENCRYPTION_KEY_LENGTH_BYTES} bytes (a base64-encoded AES-256 key); got ${key.length}.`,
    );
  }
  return key;
}
