import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A minimal RFC 4226 (HOTP) / RFC 6238 (TOTP) implementation using only
 * Node's built-in `crypto` — the same "no extra dependency" posture
 * `docs/conventions/i18n-timezone-rtl.md`'s timezone rendering and
 * `docs/conventions/integrations.md`'s OIDC JWKS verification already take
 * (Node's own primitives are enough; a full library isn't earning its
 * weight for ~80 lines of well-specified math). Used ONLY by
 * `PlatformMfaService` — mandatory MFA for every platform admin, the
 * single most dangerous surface in this system (see
 * docs/conventions/vendor-console.md).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
// Accept one step of clock drift either side, per RFC 6238's own guidance —
// tight enough to stay meaningful as a time-boxed factor, loose enough for
// ordinary client/server clock skew.
const TOTP_WINDOW_STEPS = 1;

export function generateBase32Secret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

export function base32Encode(buffer: Buffer): string {
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

function hotp(secret: Buffer, counter: bigint): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const code = (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
  return code;
}

export function generateTotp(base32Secret: string, at: Date = new Date()): string {
  const counter = BigInt(Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS));
  return hotp(base32Decode(base32Secret), counter);
}

/** Verifies a caller-supplied code against one step of drift either side, using a constant-time comparison per candidate. */
export function verifyTotp(base32Secret: string, code: string, at: Date = new Date()): boolean {
  if (!/^\d{6}$/.test(code)) {
    return false;
  }
  const secret = base32Decode(base32Secret);
  const currentCounter = BigInt(Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS));
  const codeBuffer = Buffer.from(code, 'utf8');

  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta++) {
    const candidate = Buffer.from(hotp(secret, currentCounter + BigInt(delta)), 'utf8');
    if (candidate.length === codeBuffer.length && timingSafeEqual(candidate, codeBuffer)) {
      return true;
    }
  }
  return false;
}

/** `otpauth://` URI an authenticator app (Google Authenticator, 1Password, ...) can scan/import directly. */
export function buildOtpAuthUrl(params: { secret: string; accountEmail: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountEmail}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    // xxxx-xxxx-xxxx, base32 alphabet — easy to read/type back, no
    // ambiguous characters (0/O, 1/I already excluded by BASE32_ALPHABET).
    const raw = base32Encode(randomBytes(8)).slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}
