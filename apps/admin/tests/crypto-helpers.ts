import { createCipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Test-only duplicates of `apps/api/src/common/encryption/encryption.service.ts`
 * (AES-256-GCM, identical wire format) and `apps/api/src/platform/auth/totp.util.ts`
 * (RFC 6238 TOTP) — Playwright's `globalSetup` runs as its own process with
 * no access to `apps/api`'s `src` tree, so this fixture-seeding script
 * needs its own copy of the exact same algorithms to pre-enroll an
 * already-MFA-enrolled admin fixture directly in the DB (bypassing the
 * enrollment UI for every spec EXCEPT `auth.spec.ts`, which drives that
 * flow for real). Any drift here from the real implementation would show
 * up immediately as a failing login in every other spec file.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

export function encryptSecret(plaintext: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join(':');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateBase32Secret(byteLength = 20): string {
  const buffer = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotp(base32Secret: string, at: Date = new Date()): string {
  const counter = BigInt(Math.floor(at.getTime() / 1000 / 30));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', base32Decode(base32Secret)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}
