import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { RequestPriority } from '@hrm/shared';
import { MetricsService } from '../../metrics/metrics.service';
import { SystemLoadService } from './system-load.service';

const DEFAULT_LOW_PRIORITY_THRESHOLD = 20;
const DEFAULT_NORMAL_PRIORITY_THRESHOLD = 100;
const SHED_RETRY_AFTER_SECONDS = 5;

/**
 * Load shedding (step 0.10) — see /CLAUDE.md § Conventions → Load
 * shedding. Called directly from `TenantScopeInterceptor`, as the very
 * FIRST thing it does for any HTTP request — NOT a separate global
 * `APP_INTERCEPTOR` (an earlier version of this step was, but was proven
 * WRONG by `apps/api/test/resilience.e2e-spec.ts`'s ordering test: NestJS
 * does not reliably order `APP_INTERCEPTOR`s registered in different
 * modules by their `imports` array position, so a separately-registered
 * interceptor ended up NESTED INSIDE `TenantScopeInterceptor` instead of
 * wrapping it, defeating the entire point of shedding BEFORE tenant
 * resolution/DB work). Calling this method directly, first, from within
 * `TenantScopeInterceptor` itself guarantees the ordering by construction
 * — the same "extend the existing spine, don't add a competing one"
 * approach 0.4 used to add auth to it, and 0.10 already uses for the
 * per-tenant rate-limit check.
 *
 * The "under stress" signal is deliberately simple: current in-flight
 * request count (`SystemLoadService`) against a threshold, not real
 * event-loop-lag measurement — simple, deterministic, and easy to
 * reproduce in tests; a more precise signal (event-loop lag, memory
 * pressure) is a reasonable future enhancement, not built here.
 * `CRITICAL` routes (login, health, core reads) are NEVER shed, at any
 * load — that's the whole point of marking them.
 */
@Injectable()
export class LoadSheddingService {
  constructor(
    private readonly systemLoad: SystemLoadService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Throws `ServiceUnavailableException` (with `Retry-After` set on
   * `response`) if `priority` should be shed right now. Otherwise
   * increments the in-flight counter and returns a `release()` function
   * the caller MUST invoke (in a `finally`) once the request finishes,
   * regardless of outcome.
   */
  admit(priority: RequestPriority, response: Response): () => void {
    if (priority !== 'CRITICAL' && this.systemLoad.current >= this.thresholdFor(priority)) {
      response.setHeader('Retry-After', String(SHED_RETRY_AFTER_SECONDS));
      // Phase 5.4 — see docs/conventions/observability-load.md § Metrics.
      this.metrics.incLoadShedRejection(priority);
      throw new ServiceUnavailableException(
        `The system is currently under load; this ${priority} request was shed. Please retry shortly.`,
      );
    }

    this.systemLoad.increment();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.systemLoad.decrement();
    };
  }

  private thresholdFor(priority: RequestPriority): number {
    if (priority === 'LOW') {
      return Number(this.config.get<string>('LOAD_SHED_LOW_THRESHOLD') ?? DEFAULT_LOW_PRIORITY_THRESHOLD);
    }
    return Number(this.config.get<string>('LOAD_SHED_NORMAL_THRESHOLD') ?? DEFAULT_NORMAL_PRIORITY_THRESHOLD);
  }
}
