// Phase 5.4 — see main.ts's identical comment: must be the very first
// import, before `reflect-metadata`, for OTel auto-instrumentation to
// patch `http`/`ioredis` before anything else requires them.
import './tracing/init-tracing';
import 'reflect-metadata';
import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { MetricsService } from './metrics/metrics.service';
import { ShutdownService } from './resilience/shutdown/shutdown.service';
import { ReadinessService } from './resilience/health/readiness.service';

/**
 * Phase 5.3 — the WORKER process, separately deployable and separately
 * scalable from the HTTP API (`main.ts`) — see
 * docs/conventions/deployment-scaling.md § Separate scalable workloads.
 *
 * `NestFactory.createApplicationContext(AppModule)` (not `.create()`)
 * instantiates the EXACT same DI graph `main.ts` does — every `@Processor()`
 * BullMQ worker across every feature module (notifications, payroll runs,
 * report generation, imports, partition maintenance/archival, ...)
 * registers and starts consuming its queue exactly as it would inside the
 * full HTTP app, because nothing about a `@Processor`'s registration
 * depends on an HTTP listener existing — but it binds NO HTTP listener and
 * mounts none of `AppModule`'s ~30 feature controllers. This is what makes
 * "the worker process can run independently of the API process" literally
 * true rather than just a deployment convention: it is a different Node
 * entrypoint with a genuinely smaller surface, not the same process with
 * routes ignored.
 *
 * Same business logic, same queue registrations, same 0.10 resilience
 * primitives (all Redis/DB-backed — see the statelessness audit in
 * deployment-scaling.md) — nothing here is a second implementation of
 * anything; this file is plumbing only.
 */
const SHUTDOWN_GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? 5000);
const WORKER_HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3002);

async function bootstrap() {
  const context = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  // Step 5.4 — the SAME structured logger main.ts installs for the API,
  // here for the worker: every existing `Logger` call site (including
  // inside `@Processor` classes) emits consistent JSON, tagged
  // `service: 'hrm-worker'` instead of `'hrm-api'`.
  context.useLogger(new PinoLoggerService({ serviceName: 'hrm-worker' }));
  const logger = new Logger('WorkerBootstrap');
  const shutdownService = context.get(ShutdownService);
  const readiness = context.get(ReadinessService);
  const metrics = context.get(MetricsService);

  // A minimal, purpose-built HTTP surface for a kubelet liveness/readiness
  // probe to reach this process — deliberately NOT `AppModule`'s
  // `HealthController` (that route is wired through the full HTTP app's
  // `TenantScopeInterceptor`/routing stack, which doesn't exist here).
  // Reuses `ReadinessService`/`ShutdownService` directly — same DB/Redis/
  // shutdown-flag checks the API's own `/health/ready` uses, just exposed
  // over a tiny hand-rolled server instead of Nest's HTTP layer, so the
  // worker process never needs to stand up Express/Fastify or mount a
  // single one of AppModule's feature controllers. `/metrics` rides the
  // SAME tiny server (Step 5.4) — the worker's `MetricsService` instance
  // is a SEPARATE registry from the API's own (each process registers its
  // own `collectDefaultMetrics`/queue-depth/job-duration series), scraped
  // as its own target — see docs/conventions/observability-load.md.
  // Deliberately unauthenticated here (unlike the API's `/metrics`,
  // gated by `MetricsAuthGuard`): this server has no Nest guard pipeline
  // at all, so the SAME defense-in-depth this file's own doc comment
  // already asks of every deployment (restrict this port at the network
  // layer — a NetworkPolicy/security-group rule, never expose it publicly)
  // is what secures this endpoint too.
  const healthServer = createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/health/ready') {
      readiness
        .check()
        .then((result) => {
          res.writeHead(result.ready ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((error: unknown) => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ready: false, error: String(error) }));
        });
      return;
    }
    if (req.url === '/metrics') {
      metrics
        .metricsText()
        .then((text) => {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(text);
        })
        .catch((error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  healthServer.listen(WORKER_HEALTH_PORT, () => {
    logger.log(`Worker health server listening on port ${WORKER_HEALTH_PORT}`);
  });

  // Mirrors main.ts's own SIGTERM/SIGINT handling exactly (see that
  // file's own comment) — the same "flip readiness unhealthy first, then
  // wait a grace period before actually closing" shape, applied here to
  // let in-flight BullMQ jobs finish rather than in-flight HTTP requests.
  // `context.close()` runs every module's `onModuleDestroy`/
  // `onApplicationShutdown` exactly like `app.close()` does (Nest's
  // lifecycle hooks aren't specific to `INestApplication` vs.
  // `INestApplicationContext`) — this is what closes every `WorkerHost`
  // (`@nestjs/bullmq`'s own shutdown hook waits for its currently-active
  // job(s) to finish before returning).
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
      healthServer.close();
      context
        .close()
        .then(() => {
          logger.log('Worker graceful shutdown complete.');
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error(`Error during worker graceful shutdown: ${String(error)}`);
          process.exit(1);
        });
    }, SHUTDOWN_GRACE_PERIOD_MS);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

  logger.log('HRM worker process started — consuming all registered BullMQ queues.');
}

bootstrap();
