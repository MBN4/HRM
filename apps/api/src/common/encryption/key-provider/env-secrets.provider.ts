import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decodeFieldEncryptionKey,
  type EncryptionKeyProvider,
  type EncryptionKeySet,
} from './encryption-key-provider.interface';

/**
 * The default `ENCRYPTION_KEY_PROVIDER` binding — reads key material
 * straight from env vars via `ConfigService`, exactly what
 * `EncryptionService` did directly before step 6.2. Supports KEY ROTATION:
 * `FIELD_ENCRYPTION_KEY`/`FIELD_ENCRYPTION_KEY_VERSION` name the CURRENT
 * key (what `encrypt()` writes under); `FIELD_ENCRYPTION_PREVIOUS_KEYS`
 * (`version:base64key` pairs, comma-separated) keeps retired keys
 * available so `decrypt()` can still read ciphertext written before a
 * rotation — see docs/conventions/security-hardening.md → Key rotation.
 */
@Injectable()
export class EnvSecretsProvider implements EncryptionKeyProvider {
  constructor(private readonly config: ConfigService) {}

  getKeys(): EncryptionKeySet {
    const currentVersion = this.config.get<string>('FIELD_ENCRYPTION_KEY_VERSION')?.trim() || '1';
    const currentRaw = this.config.get<string>('FIELD_ENCRYPTION_KEY');
    if (!currentRaw) {
      throw new Error('FIELD_ENCRYPTION_KEY is not set.');
    }

    const keys = new Map<string, Buffer>();
    keys.set(currentVersion, decodeFieldEncryptionKey(currentRaw, 'FIELD_ENCRYPTION_KEY'));

    const previousRaw = this.config.get<string>('FIELD_ENCRYPTION_PREVIOUS_KEYS');
    if (previousRaw) {
      for (const entry of previousRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const separatorIndex = entry.indexOf(':');
        const version = separatorIndex === -1 ? '' : entry.slice(0, separatorIndex);
        const keyB64 = separatorIndex === -1 ? '' : entry.slice(separatorIndex + 1);
        if (!version || !keyB64) {
          throw new Error(`Malformed FIELD_ENCRYPTION_PREVIOUS_KEYS entry "${entry}" (expected "version:base64key").`);
        }
        if (keys.has(version)) {
          throw new Error(`Duplicate field-encryption key version "${version}" — check FIELD_ENCRYPTION_KEY_VERSION vs. FIELD_ENCRYPTION_PREVIOUS_KEYS.`);
        }
        keys.set(version, decodeFieldEncryptionKey(keyB64, `FIELD_ENCRYPTION_PREVIOUS_KEYS[${version}]`));
      }
    }

    return { currentVersion, keys };
  }
}
