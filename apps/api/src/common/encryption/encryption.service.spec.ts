import { randomBytes } from 'node:crypto';
import type { EncryptionKeyProvider, EncryptionKeySet } from './key-provider/encryption-key-provider.interface';
import { EncryptionService } from './encryption.service';

function fixedProvider(keySet: EncryptionKeySet): EncryptionKeyProvider {
  return { getKeys: () => keySet };
}

function genKey(): Buffer {
  return randomBytes(32);
}

describe('EncryptionService', () => {
  describe('round trip', () => {
    const keyV1 = genKey();
    const service = new EncryptionService(fixedProvider({ currentVersion: '1', keys: new Map([['1', keyV1]]) }));

    it('decrypts exactly what it encrypted', () => {
      const stored = service.encrypt('super secret salary');
      expect(service.decrypt(stored)).toBe('super secret salary');
    });

    it('prefixes new ciphertext with the current key version', () => {
      const stored = service.encrypt('x');
      expect(stored.startsWith('v1:')).toBe(true);
      expect(stored.split(':')).toHaveLength(4);
    });

    it('encrypt is non-deterministic (fresh random IV each call)', () => {
      expect(service.encrypt('same plaintext')).not.toBe(service.encrypt('same plaintext'));
    });

    it('detects tampering via the GCM auth tag', () => {
      const stored = service.encrypt('tamper me');
      const parts = stored.split(':');
      // Flip the last base64 char of the ciphertext segment.
      const tampered = [...parts.slice(0, 3), parts[3].slice(0, -1) + (parts[3].endsWith('A') ? 'B' : 'A')].join(':');
      expect(() => service.decrypt(tampered)).toThrow();
    });

    it('encryptOptional/decryptOptional pass null/undefined through untouched', () => {
      expect(service.encryptOptional(null)).toBeNull();
      expect(service.encryptOptional(undefined)).toBeNull();
      expect(service.decryptOptional(null)).toBeNull();
    });
  });

  describe('backward compatibility with pre-6.2 unversioned ciphertext', () => {
    it('decrypts the legacy "<iv>:<authTag>:<data>" format (implicit version "1")', () => {
      const keyV1 = genKey();
      const service = new EncryptionService(fixedProvider({ currentVersion: '1', keys: new Map([['1', keyV1]]) }));
      const stored = service.encrypt('legacy-shaped value');

      // Simulate what every pre-6.2 encrypted DB value looks like: strip
      // the "v1:" prefix this step introduced.
      const legacyStored = stored.split(':').slice(1).join(':');
      expect(service.decrypt(legacyStored)).toBe('legacy-shaped value');
    });
  });

  describe('key rotation', () => {
    it('new ciphertext round-trips under the rotated (current) key, while old ciphertext under the retired key still decrypts', () => {
      const keyV1 = genKey();
      const keyV2 = genKey();

      const preRotation = new EncryptionService(fixedProvider({ currentVersion: '1', keys: new Map([['1', keyV1]]) }));
      const oldCiphertext = preRotation.encrypt('written before rotation');
      const legacyUnversionedCiphertext = oldCiphertext.split(':').slice(1).join(':');

      // Rotate: v2 becomes current, v1 kept only for decrypting old data —
      // exactly what moving FIELD_ENCRYPTION_KEY_VERSION=2 and adding
      // FIELD_ENCRYPTION_PREVIOUS_KEYS=1:<old key> does in production.
      const postRotation = new EncryptionService(
        fixedProvider({
          currentVersion: '2',
          keys: new Map([
            ['1', keyV1],
            ['2', keyV2],
          ]),
        }),
      );

      expect(postRotation.decrypt(oldCiphertext)).toBe('written before rotation');
      expect(postRotation.decrypt(legacyUnversionedCiphertext)).toBe('written before rotation');

      const newCiphertext = postRotation.encrypt('written after rotation');
      expect(newCiphertext.startsWith('v2:')).toBe(true);
      expect(postRotation.decrypt(newCiphertext)).toBe('written after rotation');

      // The retired key can no longer decrypt data it never actually wrote
      // (sanity: v1's key must not somehow work against v2 ciphertext).
      expect(() => preRotation.decrypt(newCiphertext)).toThrow();
    });

    it('throws a clear error when asked to decrypt a version no longer available (rotated away without keeping it in FIELD_ENCRYPTION_PREVIOUS_KEYS)', () => {
      const keyV1 = genKey();
      const keyV2 = genKey();
      const before = new EncryptionService(fixedProvider({ currentVersion: '1', keys: new Map([['1', keyV1]]) }));
      const stored = before.encrypt('orphaned after a careless rotation');

      const after = new EncryptionService(fixedProvider({ currentVersion: '2', keys: new Map([['2', keyV2]]) }));
      expect(() => after.decrypt(stored)).toThrow(/No field-encryption key available for version "1"/);
    });

    it('throws at construction if the provider does not actually supply its declared current version', () => {
      expect(() => new EncryptionService(fixedProvider({ currentVersion: '3', keys: new Map([['1', genKey()]]) }))).toThrow(
        /did not return a key for its own declared currentVersion "3"/,
      );
    });
  });

  describe('malformed input', () => {
    const service = new EncryptionService(fixedProvider({ currentVersion: '1', keys: new Map([['1', genKey()]]) }));

    it('rejects a value with the wrong number of segments', () => {
      expect(() => service.decrypt('not-a-real-value')).toThrow(/Malformed encrypted field value/);
    });
  });
});
