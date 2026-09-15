/**
 * Field names that must NEVER reach durable storage un-redacted — auth's
 * `token` (a live password-reset secret, flagged as sensitive at
 * `AuthEventPayload.token` since 0.8), password hashes, refresh/access
 * tokens, signed license material (`License.signedToken`, license file
 * contents), and — since step 1.1 — an Employee response's whole
 * `bankDetails`/`compensation` objects (redacting the CONTAINER key rather
 * than each leaf field is the same "safer to over-redact" call as
 * everything else in this pattern: it also catches `salaryCurrency`, which
 * isn't sensitive on its own but isn't worth a narrower carve-out either —
 * see docs/conventions/employee.md). Matched case-insensitively against
 * object KEYS at any depth, not by an exhaustive per-event field-path list
 * — simpler and safer to over-redact (a field named `token` nested three
 * levels deep is still a token) than to maintain a path list that silently
 * misses a new nesting as modules evolve. See
 * docs/conventions/audit-custom-fields.md. Extended in step 2.1 (Payroll)
 * to also match `grossPay`/`netPay`/`employerCost`/`componentBreakdown` —
 * a `PayrollRunLine`'s computed amounts are exactly as sensitive as
 * `compensation`, redacted the same "over-redact the whole value, don't
 * enumerate leaf fields" way. Extended in step 2.3 (Recruitment lifecycle)
 * to also match `proposedSalary` — an `Offer`'s proposed compensation is
 * exactly as sensitive as an `Employee`'s, redacted the same way. Extended
 * in step 5.4 to also match `ssn`/`cnic`/`ntn`/`qatarId`/`nationalId`/
 * `passportNumber`/`bankAccount`/`iban`/`taxId` — `Employee.statutoryFields`
 * (country-pack-driven required-field keys like `SSN`/`CNIC`/`NTN`/
 * `QATAR_ID`, see docs/conventions/employee.md/pakistan-pack.md) is now
 * ALSO reachable from structured logs, not just the audit sink this
 * pattern originally shipped for — `PinoLoggerService` (see
 * docs/conventions/observability-load.md) reuses this exact function as
 * its log-scrubbing mechanism, so every term added here protects both
 * sinks at once, automatically.
 */
const REDACTED_KEY_PATTERN =
  /password|token|secret|privateKey|licenseFile|signedToken|bankDetails|compensation|grossPay|netPay|employerCost|componentBreakdown|proposedSalary|ssn|cnic|ntn|qatarId|nationalId|passportNumber|bankAccount|iban|taxId/i;

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
    // A live class instance (Prisma's `Decimal`, `Date`, ...) — not a
    // plain `{...}` object — walking its OWN enumerable properties via
    // `Object.entries` reconstructs its internal representation instead
    // of its actual value (a `Decimal`'s `{s, e, d}` digit encoding, a
    // `Date`'s empty `{}`), which for `Decimal` specifically isn't even
    // valid JSON (its internals aren't plain-serializable) and throws at
    // the `audit_log` write. `toJSON()` is the SAME protocol
    // `JSON.stringify` itself already uses to get a value's actual
    // serializable representation — reuse it here instead of walking the
    // instance structurally, then keep redacting from that point.
    if (Object.getPrototypeOf(value) !== Object.prototype && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return redactRecursive((value as { toJSON: () => unknown }).toJSON());
    }
    const entries = Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      REDACTED_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : redactRecursive(v),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}
