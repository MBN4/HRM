import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ShutdownService } from './resilience/shutdown/shutdown.service';
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
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors();

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
