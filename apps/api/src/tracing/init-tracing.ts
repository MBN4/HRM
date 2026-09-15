/**
 * Phase 5.4 — OpenTelemetry tracing bootstrap. MUST be the very first
 * thing `main.ts`/`worker.ts` import (before even `reflect-metadata`) —
 * auto-instrumentation works by monkey-patching a module's exports the
 * FIRST time Node's module loader `require()`s it (`http`, `express`,
 * `ioredis`), so the SDK has to be listening before anything else in the
 * dependency graph (Nest, Express, ioredis, all pulled in transitively by
 * `AppModule`) gets its first `require()`.
 *
 * Exporter seam — the SAME "real binding only when configured, a safe
 * local default otherwise" pattern as `error-tracker.ts`/Stripe/ACME:
 * `OTEL_EXPORTER_OTLP_ENDPOINT` set -> OTLP/HTTP export to a real
 * collector (Tempo, Jaeger, an OTel Collector, ...); unset (every local/
 * CI run) -> `ConsoleSpanExporter`, which prints completed spans to
 * stdout — a genuine, inspectable local story (you can literally watch
 * spans as they complete), not a silent no-op.
 *
 * This module is imported ONLY by `main.ts`/`worker.ts` — never by
 * `AppModule` or anything under `apps/api/test`, so it never runs under
 * Jest at all (no `NODE_ENV === 'test'` guard needed): e2e/unit specs
 * compile `AppModule` directly via `Test.createTestingModule`, which
 * never touches this file.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'hrm-api',
  traceExporter: otlpEndpoint ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }) : new ConsoleSpanExporter(),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    // Traces every Redis command (rate limiting, idempotency, circuit
    // breaker state, BullMQ's own internals) as a child span automatically
    // — real "api -> redis" tracing with zero application code changes.
    new IORedisInstrumentation(),
  ],
});

sdk.start();

// `NodeSDK.shutdown()` flushes any buffered/batched spans before the
// process actually exits — the same "drain before closing" discipline
// `main.ts`/`worker.ts`'s own SIGTERM handling already applies to HTTP
// requests/BullMQ jobs, extended here to telemetry so a graceful shutdown
// doesn't silently drop the last few seconds of trace data.
process.on('SIGTERM', () => {
  sdk.shutdown().catch(() => undefined);
});
