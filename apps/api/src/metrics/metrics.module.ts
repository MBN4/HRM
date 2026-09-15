import { Global, Module } from '@nestjs/common';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * Phase 5.4 — `@Global()` so `MetricsService` (the shared prom-client
 * registry) is injectable from any module without an explicit import —
 * the same reasoning `TenancyModule`/`ResilienceModule`/`RedisModule`
 * already document for their own `@Global()` — and because the 6-7 small
 * instrumentation hooks this step adds (rate limiting, load shedding, pool
 * exhaustion, the circuit breaker, the 3 caches) live in modules that have
 * no existing reason to import a metrics-specific module otherwise.
 * Imported by `AppModule` for the api process AND reachable via
 * `context.get(MetricsService)` in the worker process's application
 * context (`worker.ts`) — see that file for the worker's own `/metrics`
 * wiring on its hand-rolled health server.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, QueueMetricsService, MetricsAuthGuard],
  exports: [MetricsService],
})
export class MetricsModule {}
