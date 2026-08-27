import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CircuitBreakerService } from './circuit-breaker/circuit-breaker.service';
import { FlakyDependencyService } from './demo/flaky-dependency.service';
import { ResilienceDemoController } from './demo/resilience-demo.controller';
import { DbPoolExhaustionFilter } from './db-pool-exhaustion.filter';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { IdempotencyService } from './idempotency/idempotency.service';
import { LoadSheddingService } from './load-shedding/load-shedding.service';
import { SystemLoadService } from './load-shedding/system-load.service';
import { RateLimitAdminController } from './rate-limit/rate-limit-admin.controller';
import { RateLimitExceptionFilter } from './rate-limit/rate-limit-exception.filter';
import { TenantRateLimitService } from './rate-limit/tenant-rate-limit.service';
import { ShutdownService } from './shutdown/shutdown.service';

/**
 * The resilience chassis (step 0.10) — "degrades gracefully, never
 * collapses". See /CLAUDE.md § Conventions for the full write-up of each
 * mechanism. `@Global()` so every piece here (`CircuitBreakerService`,
 * `IdempotencyService`/`IdempotencyInterceptor`, `TenantRateLimitService`,
 * `LoadSheddingService`, ...) is usable from any module without an
 * explicit import — same reasoning `TenancyModule`/`RedisModule`/
 * `AuditModule` already document for their own `@Global()`, and what lets
 * `TenantScopeInterceptor` (in `TenancyModule`) depend on
 * `TenantRateLimitService`/`LoadSheddingService` (provided here) with no
 * import cycle between the two modules.
 *
 * Load shedding and the request timeout are DELIBERATELY NOT separate
 * global `APP_INTERCEPTOR`s — an earlier version of this step registered
 * them that way and relied on `AppModule` importing `ResilienceModule`
 * before `TenancyModule` to make them wrap `TenantScopeInterceptor`. That
 * was PROVEN WRONG by `apps/api/test/resilience.e2e-spec.ts`'s ordering
 * test: NestJS does not reliably order `APP_INTERCEPTOR`s registered in
 * different modules by `imports` array position, and the interceptor
 * ended up nested INSIDE `TenantScopeInterceptor` instead of outside it.
 * Both are now plain services (`LoadSheddingService`, and the timeout
 * logic inline) called DIRECTLY from `TenantScopeInterceptor` itself,
 * first thing, guaranteeing the ordering by construction — the same
 * "extend the existing spine, don't add a competing one" approach 0.4
 * used to add auth to it, and this step already uses for the per-tenant
 * rate-limit check.
 */
@Global()
@Module({
  controllers: [HealthController, RateLimitAdminController, ResilienceDemoController],
  providers: [
    { provide: APP_FILTER, useClass: RateLimitExceptionFilter },
    { provide: APP_FILTER, useClass: DbPoolExhaustionFilter },
    SystemLoadService,
    LoadSheddingService,
    TenantRateLimitService,
    CircuitBreakerService,
    IdempotencyService,
    IdempotencyInterceptor,
    ShutdownService,
    ReadinessService,
    FlakyDependencyService,
  ],
  exports: [
    LoadSheddingService,
    TenantRateLimitService,
    CircuitBreakerService,
    IdempotencyService,
    IdempotencyInterceptor,
    ShutdownService,
    ReadinessService,
  ],
})
export class ResilienceModule {}
