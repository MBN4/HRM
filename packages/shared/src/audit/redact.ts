/**
 * Field names that must NEVER reach durable storage un-redacted — auth's
 * `token` (a live password-reset secret, flagged as sensitive at
 * `AuthEventPayload.token` since 0.8), password hashes, refresh/access
 * tokens, and signed license material (`License.signedToken`, license
 * file contents). Matched case-insensitively against object KEYS at any
 * depth, not by an exhaustive per-event field-path list — simpler and
 * safer to over-redact (a field named `token` nested three levels deep is
 * still a token) than to maintain a path list that silently misses a new
 * nesting as modules evolve. See /CLAUDE.md § Conventions → Audit log.
 */
const REDACTED_KEY_PATTERN = /password|token|secret|privateKey|licenseFile|signedToken/i;

const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Deep-clones `value`, replacing any object value whose KEY matches
 * `REDACTED_KEY_PATTERN` with a fixed placeholder. Applied by the audit
 * sink (both `AuditInterceptor` and the domain-event listener) as the
 * LAST step before a `before`/`after`/`metadata` payload is written to
 * `audit_log` — never trust a caller to have redacted it already; this is
 * a backstop, consistent with this project's "no single layer of security
 * is trusted alone" posture (see RLS, the rules-engine sandbox).
 */
export function redactSensitiveFields<T>(value: T): T {
  return redactRecursive(value) as T;
}

function redactRecursive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactRecursive);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      REDACTED_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : redactRecursive(v),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}
