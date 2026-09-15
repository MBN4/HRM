import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TooManyAttemptsException } from '../../redis/rate-limiter.service';
import { MetricsService } from '../../metrics/metrics.service';

/** Step 3.3's API-key path scopes its own rate limit under this prefix — see `ApiKeyRateLimitService`. Everything else is the per-tenant quota. */
const API_KEY_PATH_PREFIX = '/v1';

/**
 * Sets the `Retry-After` header every 429 in this system should carry —
 * `TooManyAttemptsException` (0.4's auth rate limiting, and 0.10's
 * per-tenant quota, both built on the same `RateLimiterService`) already
 * computed `retryAfterSeconds`, it just had nowhere to put it before this
 * filter existed. Registered globally (`APP_FILTER`), so this is a
 * retroactive fix for the auth endpoints too, not just new 0.10 behavior
 * — no auth call site needed to change.
 *
 * Phase 5.4 — every 429 ALSO increments `hrm_rate_limit_rejections_total`
 * here, the ONE choke point every rate limiter (auth login, per-tenant
 * quota, per-API-key quota) already funnels through — no need to touch
 * `RateLimiterService`/`TenantRateLimitService`/`ApiKeyRateLimitService`
 * individually. `source` is a best-effort classification from the request
 * path only (never a tenant id — see `MetricsService`'s own cardinality
 * note).
 */
@Catch(TooManyAttemptsException)
export class RateLimitExceptionFilter implements ExceptionFilter {
  constructor(private readonly metrics: MetricsService) {}

  catch(exception: TooManyAttemptsException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(exception.getStatus()).json(exception.getResponse());
    this.metrics.incRateLimitRejection(this.classify(request));
  }

  private classify(request: Request): 'tenant' | 'api-key' | 'auth' {
    if (request.path.startsWith(API_KEY_PATH_PREFIX)) {
      return 'api-key';
    }
    if (request.path.startsWith('/auth/')) {
      return 'auth';
    }
    return 'tenant';
  }
}
