/**
 * Phase 5.4 — error tracking via a swappable seam, the SAME "bind a real
 * implementation only when its secret is configured, a Noop/mock
 * otherwise" pattern this codebase already uses for
 * `STRIPE_SECRET_KEY`/`MockStripeClient` (billing.md) and
 * `ACME_ENABLED`/`MockCertProvider` (white-label.md). Deliberately a plain
 * factory function, NOT a Nest DI token resolved through the container:
 * `PinoLoggerService` is constructed manually in `main.ts`/`worker.ts`
 * BEFORE `NestFactory.create`/`createApplicationContext` runs (so it can
 * capture bootstrap-time logs too, via `bufferLogs: true`), meaning
 * nothing DI-registered exists yet at the point it needs an error
 * tracker. A plain module-level singleton (`sharedErrorTracker` below)
 * avoids double-initializing the Sentry SDK regardless of how many places
 * reference it — `LoggingModule` also exposes it as an injectable
 * (`ERROR_TRACKER` token) for any service that wants to call
 * `captureException` explicitly, e.g. a background job's own catch block.
 */
export interface ErrorTracker {
  /**
   * `context` is attached to the captured event as extra, structured
   * data — callers MUST pass only already-safe identifiers (tenantId,
   * requestId, userId, route) here, never a raw request body/response or
   * an entity object; `PinoLoggerService.error()` (the primary caller)
   * only ever passes the same small, already-scrubbed set every log line
   * carries, never the free-form message/args a caller logged.
   */
  captureException(error: unknown, context?: Record<string, string | number | boolean | null | undefined>): void;
}

class NoopErrorTracker implements ErrorTracker {
  captureException(): void {
    // Intentionally does nothing — this is the "no DSN configured" local/CI
    // default. PinoLoggerService still logs the error to stdout regardless
    // of which tracker is bound; this only decides whether it's ALSO sent
    // to an external error-tracking service.
  }
}

class SentryErrorTracker implements ErrorTracker {
  private readonly sentry: typeof import('@sentry/node');

  constructor(dsn: string) {
    // Lazy `require` rather than a top-level `import` — the Sentry SDK's
    // own instrumentation (HTTP/console hooks) should only ever be loaded
    // into the process when a real DSN is actually configured; requiring
    // it unconditionally at module-load time would mean every local/CI run
    // (no DSN set, `NoopErrorTracker` bound instead) still pays for
    // loading and initializing code that's never used.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.sentry = require('@sentry/node');
    this.sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.RELEASE_VERSION,
      // Structured logs already give us full request/tenant context server
      // side — Sentry's own request-data integration would otherwise
      // capture raw headers/cookies, a second, less-audited path to the
      // same class of leak this codebase's `redactSensitiveFields`
      // discipline exists to prevent.
      sendDefaultPii: false,
    });
  }

  captureException(error: unknown, context?: Record<string, string | number | boolean | null | undefined>): void {
    this.sentry.captureException(error, { extra: context });
  }
}

export function createErrorTracker(): ErrorTracker {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return new NoopErrorTracker();
  }
  return new SentryErrorTracker(dsn);
}

/**
 * ONE shared instance per process — both `PinoLoggerService` (constructed
 * directly in `main.ts`/`worker.ts`) and `LoggingModule`'s `ERROR_TRACKER`
 * DI binding reference this SAME object, so `Sentry.init()` is called at
 * most once per process regardless of how many places need the tracker.
 */
export const sharedErrorTracker: ErrorTracker = createErrorTracker();
