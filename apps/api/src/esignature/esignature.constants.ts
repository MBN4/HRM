/**
 * `entityType`s this module's completion listener reacts to specially —
 * see docs/conventions/e-signatures.md. A `SignatureRequest` with any OTHER
 * `entityType` (or none at all — a bare uploaded contract) simply has no
 * side effect wired up; completing it just leaves the request `COMPLETED`
 * with a certificate, which is a perfectly valid terminal state on its own.
 */
export const OFFER_ENTITY_TYPE = 'Offer';
export const POLICY_ENTITY_TYPE = 'Policy';

/** Mirrors `API_KEY_PREFIX_LENGTH` (see `apps/api/src/auth/api-key/api-key-auth.service.ts`) — the same indexed-lookup-prefix + argon2id-hash pattern, applied to an external signing token instead of an API key. */
export const SIGNING_TOKEN_PREFIX_LENGTH = 12;

export const DEFAULT_SIGNING_LINK_EXPIRY_DAYS = 14;

export const MAX_LIST_RESULTS = 200;
