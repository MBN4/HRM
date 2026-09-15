import { ArgumentsHost, Catch, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@hrm/db';
import type { Response } from 'express';
import { MetricsService } from '../metrics/metrics.service';

const POOL_TIMEOUT_ERROR_CODE = 'P2024';
/**
 * Phase 5.4 — a REAL bug this step's own k6 load test caught (see
 * docs/conventions/observability-load.md § Load testing findings): under
 * genuine concurrent load, the error that actually surfaces is NOT
 * `P2024` (raised for a plain query awaiting a pooled connection) but
 * `P2028` ("Transaction API error: Unable to start a transaction in the
 * given time") — raised by Prisma's OWN interactive-`$transaction()`
 * wrapper when it can't acquire a connection and begin the transaction
 * within its `maxWait`. This is the code path that ACTUALLY fires for
 * this codebase's architecture, because EVERY tenant-scoped request runs
 * inside exactly that kind of transaction (`withTenantContext`, opened by
 * `TenantScopeInterceptor` for literally every request — see
 * tenant-resolution.md) — P2024 only fires for a plain query issued
 * OUTSIDE any transaction wrapper, which barely occurs anywhere in this
 * codebase. Before this fix, a request that hit P2028 fell through to
 * `super.catch()` below and surfaced as a generic, confusing `500` —
 * exactly the "no clean backpressure signal" failure mode this filter
 * exists to prevent, just for the code path this codebase's OWN
 * transaction-per-request design actually exercises.
 */
const TRANSACTION_START_TIMEOUT_ERROR_CODE = 'P2028';
const POOL_EXHAUSTION_ERROR_CODES: ReadonlySet<string> = new Set([
  POOL_TIMEOUT_ERROR_CODE,
  TRANSACTION_START_TIMEOUT_ERROR_CODE,
]);
const POOL_EXHAUSTION_RETRY_AFTER_SECONDS = 2;

/**
 * Connection-pool exhaustion protection (step 0.10) — see /CLAUDE.md §
 * Conventions → Connection-pool protection. Prisma throws
 * `PrismaClientKnownRequestError` with code `P2024` ("Timed out fetching a
 * new connection from the pool") when every pooled connection is checked
 * out and `pool_timeout` (see `packages/db/src/pool-config.ts`) elapses
 * before one frees up, OR `P2028` (see that constant's own doc comment)
 * when an interactive transaction specifically can't start in time.
 * Without this filter, either error would surface as a generic, confusing
 * `500`; this catches SPECIFICALLY those two codes and turns them into a
 * clean `503` with `Retry-After` — the actual backpressure signal this
 * step's brief asks for ("connection-pool exhaustion returns
 * 503/backpressure, not a hang").
 *
 * Extends `BaseExceptionFilter` and delegates (`super.catch`) for any
 * OTHER Prisma error code, rather than re-throwing from inside `catch()`
 * (which Nest does not cleanly re-route to the next filter) — this is the
 * standard "handle my one case, defer everything else to default
 * behavior" pattern, so a real query/data error still gets Nest's normal
 * handling, never masked as capacity pressure.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class DbPoolExhaustionFilter extends BaseExceptionFilter {
  constructor(
    httpAdapterHost: HttpAdapterHost,
    private readonly metrics: MetricsService,
  ) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    if (!POOL_EXHAUSTION_ERROR_CODES.has(exception.code)) {
      super.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(POOL_EXHAUSTION_RETRY_AFTER_SECONDS));
    const serviceUnavailable = new ServiceUnavailableException(
      'The service is temporarily at capacity (database connection pool exhausted). Please retry shortly.',
    );
    response.status(serviceUnavailable.getStatus()).json(serviceUnavailable.getResponse());
    // Phase 5.4 — a real, actionable DB-saturation signal (see
    // docs/conventions/observability-load.md § Metrics and its alert rule).
    this.metrics.incPoolExhaustion();
  }
}
