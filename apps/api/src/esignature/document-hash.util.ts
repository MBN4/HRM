import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest of the exact bytes given — the ONE hashing primitive
 * this whole module builds its tamper-evidence on: `SignatureRequest.
 * documentHash` (computed once, at creation, from the source document
 * bytes) and every `SignatureEvent.documentHash` (recomputed at each
 * signing/viewing moment) are both produced by this same function, so
 * "does the document I'm signing match what was hashed at creation" and
 * "has the stored object been tampered with since" are both answered by a
 * plain string comparison, never a second hashing scheme.
 */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
