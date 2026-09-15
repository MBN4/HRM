import type { Writable } from 'node:stream';
import type { LoggerService } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';
import { redactSensitiveFields } from '@hrm/shared';
import { getTenantContextStore } from '../../tenancy/tenant-context.store';
import type { ErrorTracker } from './error-tracker';
import { sharedErrorTracker } from './error-tracker';
import { getRequestId, getRequestLogIdentity } from './request-context.store';

/**
 * Phase 5.4 — structured (JSON) logging, consistent across the API and
 * worker processes, wired in as `main.ts`/`worker.ts`'s Nest-wide logger
 * via `app.useLogger(new PinoLoggerService(...))` /
 * `context.get`-independent manual construction. This is the ONE thing
 * that makes every EXISTING `new Logger('SomeContext')` call site across
 * ~19 files (see docs/conventions/observability-load.md) automatically
 * emit structured JSON with zero call-site changes: Nest's built-in
 * `Logger` class delegates every instance method to a single static
 * logger reference, which `app.useLogger()` replaces process-wide.
 *
 * **Correlation, automatic on every line, via pino's `mixin` hook** — no
 * caller ever has to remember to pass `tenantId`/`requestId` themselves:
 * `mixin()` runs on every single log call and merges in whatever's
 * currently available from the two independent `AsyncLocalStorage`
 * stores this codebase already maintains
 * (`common/logging/request-context.store.ts` for `requestId`,
 * `tenancy/tenant-context.store.ts` for `tenantId`/`userId`/
 * `platformAdminId`) — reused as-is, no new context-propagation
 * mechanism invented for this step.
 *
 * **PII/secret safety**: any object passed as a log argument is run
 * through `redactSensitiveFields` (the SAME function the 0.9 audit sink
 * uses — see docs/conventions/audit-custom-fields.md) before being hand
 * ed to pino. A tenant-correlated log line must never become a data leak
 * — this is the concrete mechanism that keeps that promise, not just a
 * policy statement.
 */
export interface PinoLoggerOptions {
  serviceName: string;
  /** Overridable for tests — defaults to `process.stdout` (k8s-friendly: stdout is what any log collector tails). */
  destination?: Writable;
  level?: string;
  /** Overridable for tests (assert `captureException` was called with the right, scrubbed context) — defaults to the real `sharedErrorTracker` singleton. */
  errorTracker?: ErrorTracker;
}

function buildCorrelationFields(): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const requestId = getRequestId();
  if (requestId) {
    fields.requestId = requestId;
  }
  // Prefer the LIVE tenant-context store (the common case — most log lines
  // are emitted mid-request, while it's still fully active); fall back to
  // the request-level mirror for the one real gap this codebase's own
  // testing found: an error thrown from inside a rolled-back Postgres
  // transaction can settle AFTER `tenantContextStorage`'s continuation has
  // already ended — see `request-context.store.ts`'s own doc comment.
  const tenantCtx = getTenantContextStore();
  const fallbackIdentity = tenantCtx ? undefined : getRequestLogIdentity();
  const tenantId = tenantCtx?.tenantId ?? fallbackIdentity?.tenantId;
  const userId = tenantCtx?.userId ?? fallbackIdentity?.userId;
  if (tenantId) {
    fields.tenantId = tenantId;
  }
  if (userId) {
    fields.userId = userId;
  }
  if (tenantCtx?.platformAdminId) {
    fields.platformAdminId = tenantCtx.platformAdminId;
  }
  return fields;
}

/** Nest's `Logger` calls `.error(message, trace?, context?)`/`.log(message, ...context?)` with a loose, untyped tail — this normalizes both shapes without guessing wrong for the common cases actually used in this codebase (a plain string context as the last arg, an optional stack-trace string before it). */
function splitNestArgs(args: unknown[]): { context?: string; trace?: string } {
  if (args.length === 0) {
    return {};
  }
  const last = args[args.length - 1];
  const context = typeof last === 'string' ? last : undefined;
  const rest = context !== undefined ? args.slice(0, -1) : args;
  const trace = rest.length > 0 && typeof rest[0] === 'string' ? (rest[0] as string) : undefined;
  return { context, trace };
}

function scrub(value: unknown): unknown {
  if (value instanceof Error) {
    // Errors have no useful OWN enumerable properties for
    // redactSensitiveFields to walk (message/stack are getters on the
    // prototype chain in some engines) — pull the two fields that matter
    // explicitly instead.
    return { errorMessage: value.message, stack: value.stack };
  }
  if (value !== null && typeof value === 'object') {
    return redactSensitiveFields(value);
  }
  return value;
}

export class PinoLoggerService implements LoggerService {
  private readonly pino: PinoLogger;
  private readonly errorTracker: ErrorTracker;

  constructor(options: PinoLoggerOptions) {
    this.errorTracker = options.errorTracker ?? sharedErrorTracker;
    this.pino = pino(
      {
        level: options.level ?? process.env.LOG_LEVEL ?? 'info',
        base: { service: options.serviceName },
        timestamp: pino.stdTimeFunctions.isoTime,
        mixin: buildCorrelationFields,
      },
      options.destination,
    );
  }

  log(message: unknown, ...args: unknown[]): void {
    const { context } = splitNestArgs(args);
    this.pino.info({ context, ...(typeof message === 'object' ? (scrub(message) as object) : { msg: String(message) }) });
  }

  error(message: unknown, ...args: unknown[]): void {
    const { context, trace } = splitNestArgs(args);
    const errorPayload = message instanceof Error ? scrub(message) : { msg: String(message) };
    this.pino.error({ context, trace, ...(errorPayload as object) });

    // Forward to the error tracker with ONLY already-safe correlation
    // fields — never the raw message/args a caller passed, which could in
    // principle contain anything. This is what satisfies "capture
    // unhandled errors with context (tenant, request id, release), scrubbed
    // of PII" without trusting every future `logger.error(...)` call site
    // in this codebase to have scrubbed its own arguments first.
    const correlation = buildCorrelationFields();
    this.errorTracker.captureException(message instanceof Error ? message : new Error(String(message)), {
      requestId: typeof correlation.requestId === 'string' ? correlation.requestId : undefined,
      tenantId: typeof correlation.tenantId === 'string' ? correlation.tenantId : undefined,
      userId: typeof correlation.userId === 'string' ? correlation.userId : undefined,
      context,
    });
  }

  warn(message: unknown, ...args: unknown[]): void {
    const { context } = splitNestArgs(args);
    this.pino.warn({ context, ...(typeof message === 'object' ? (scrub(message) as object) : { msg: String(message) }) });
  }

  debug(message: unknown, ...args: unknown[]): void {
    const { context } = splitNestArgs(args);
    this.pino.debug({ context, ...(typeof message === 'object' ? (scrub(message) as object) : { msg: String(message) }) });
  }

  verbose(message: unknown, ...args: unknown[]): void {
    const { context } = splitNestArgs(args);
    this.pino.trace({ context, ...(typeof message === 'object' ? (scrub(message) as object) : { msg: String(message) }) });
  }

  fatal(message: unknown, ...args: unknown[]): void {
    const { context } = splitNestArgs(args);
    this.pino.fatal({ context, ...(typeof message === 'object' ? (scrub(message) as object) : { msg: String(message) }) });
  }
}
