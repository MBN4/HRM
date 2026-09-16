// Phase 5.4 — MUST be the very first import (before even `reflect-metadata`):
// OpenTelemetry auto-instrumentation patches `http`/`express`/`ioredis` at
// their first `require()`, so the SDK must be listening before anything
// else in the dependency graph pulls those modules in. See
// tracing/init-tracing.ts's own doc comment.
import './tracing/init-tracing';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { requestIdMiddleware } from './common/logging/request-id.middleware';
import { createHttpMetricsMiddleware } from './metrics/http-metrics.middleware';
import { MetricsService } from './metrics/metrics.service';
import { ShutdownService } from './resilience/shutdown/shutdown.service';
import { configureSecurity } from './security/configure-security';
import { configureTrustedProxy } from './security/trusted-proxy';
import { setupSwagger } from './swagger';

/**
 * How long to keep serving in-flight requests, with readiness already
 * reporting unhealthy, before actually closing the server (step 0.10) —
 * see /CLAUDE.md § Conventions → Graceful degradation + health. Long
 * enough for a load balancer's own health-check interval to notice
 * `/health/ready` failing and stop routing new traffic here before the
 * listener actually closes.
 */
const SHUTDOWN_GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? 5000);

async function bootstrap() {
  // `rawBody: true` (step 4.2) — keeps the original request Buffer
  // alongside Nest's normal parsed `req.body`, needed by
  // `StripeWebhookController` to verify the `Stripe-Signature` header
  // against the EXACT bytes Stripe signed (re-serializing the parsed JSON
  // would not byte-for-byte match, and HMAC verification is byte-exact by
  // construction) — see docs/conventions/billing.md.
  // `bufferLogs: true` — Nest's own bootstrap-time log calls (module
  // initialization, route mapping) are queued rather than dropped, then
  // flushed the instant `app.useLogger()` below installs the structured
  // logger, so even boot logs come out as consistent JSON.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bufferLogs: true });

  // Step 5.4 — replaces Nest's default console logger for the ENTIRE
  // process: every existing `new Logger('SomeContext')` call site
  // throughout this codebase (see docs/conventions/observability-load.md)
  // now emits structured JSON with zero call-site changes, because Nest's
  // `Logger` class delegates to one static, replaceable reference.
  app.useLogger(new PinoLoggerService({ serviceName: 'hrm-api' }));

  // Step 6.3 — makes `req.ip` resolve the REAL client behind whatever edge
  // (k8s ingress, and optionally a CDN/WAF in front of it) sits in front
  // of this process, instead of that edge's own address — see
  // docs/conventions/edge-security.md and trusted-proxy.ts's own doc
  // comment. Must run before any request is handled; ordering relative to
  // configureSecurity/Swagger below doesn't matter otherwise.
  configureTrustedProxy(app, app.get(ConfigService));

  // Step 6.2 — secure headers (helmet, CSP tuned for /v1/docs) + a real
  // CORS allow-list, replacing the previous `app.enableCors()` with NO
  // options at all (any origin) — see docs/conventions/security-hardening.md.
  // Factored out so the e2e suite can exercise the SAME wiring.
  configureSecurity(app);
  app.use(requestIdMiddleware);
  app.use(createHttpMetricsMiddleware(app.get(MetricsService)));

  // Step 3.3 — OpenAPI/Swagger for the versioned public API ONLY, not this
  // codebase's entire internal surface — see setupSwagger's own doc
  // comment.
  setupSwagger(app);

  const logger = new Logger('Bootstrap');
  const shutdownService = app.get(ShutdownService);

  // Deliberately NOT `app.enableShutdownHooks()` — its default behavior
  // calls `app.close()` immediately on SIGTERM/SIGINT, with no gap for a
  // load balancer to notice readiness failing first. This handler owns
  // that gap explicitly: mark unhealthy -> wait -> THEN close, draining
  // in-flight requests (Node's underlying `server.close()`, which
  // `app.close()` calls, stops accepting NEW connections immediately but
  // waits for existing ones to finish) and every module's own
  // `onModuleDestroy`/`onApplicationShutdown` (DB pools, Redis, BullMQ
  // workers) as part of `app.close()` itself.
  let shuttingDown = false;
  const handleShutdownSignal = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log(
      `Received ${signal} — readiness now unhealthy, draining for ${SHUTDOWN_GRACE_PERIOD_MS}ms before closing.`,
    );
    shutdownService.beginShutdown();

    setTimeout(() => {
      app
        .close()
        .then(() => {
          logger.log('Graceful shutdown complete.');
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error(`Error during graceful shutdown: ${String(error)}`);
          process.exit(1);
        });
    }, SHUTDOWN_GRACE_PERIOD_MS);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`HRM API listening on port ${port}`);
}

bootstrap();
