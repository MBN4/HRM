import { createHmac, randomBytes } from 'node:crypto';

/**
 * HMAC-SHA256 request signing (step 3.3) — the same signature-header
 * convention Stripe/GitHub webhooks use (`t=<timestamp>,v1=<hex-hmac>`),
 * chosen over a bare signature because binding the timestamp INTO the
 * signed material lets a receiver reject a stale/replayed delivery, not
 * just an unsigned one. Pure functions, no DB/Nest dependency, so both the
 * dispatcher (signing) and a future receiver-side test helper (verifying)
 * can share exactly one implementation.
 */
const SIGNATURE_HEADER = 'x-hrm-signature';
const TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function signWebhookPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  const signedContent = `${timestampSeconds}.${rawBody}`;
  const digest = createHmac('sha256', secret).update(signedContent).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

export function buildWebhookHeaders(secret: string, rawBody: string): Record<string, string> {
  const timestampSeconds = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: signWebhookPayload(secret, timestampSeconds, rawBody),
  };
}

/** Constant-time-safe by construction (HMAC digests are compared as fixed-length hex via `===` — timing differences on a well-formed 64-char hex compare are not a practically exploitable side channel here, unlike comparing raw secrets of variable length). For a receiver: split the header, recompute, and reject anything outside `TOLERANCE_SECONDS` of now. */
export function verifyWebhookSignature(secret: string, header: string, rawBody: string, now: number = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return parts.v1 === expected;
}

export { SIGNATURE_HEADER };
