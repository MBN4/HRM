import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { TooManyAttemptsException } from '../../redis/rate-limiter.service';

/**
 * Sets the `Retry-After` header every 429 in this system should carry —
 * `TooManyAttemptsException` (0.4's auth rate limiting, and 0.10's
 * per-tenant quota, both built on the same `RateLimiterService`) already
 * computed `retryAfterSeconds`, it just had nowhere to put it before this
 * filter existed. Registered globally (`APP_FILTER`), so this is a
 * retroactive fix for the auth endpoints too, not just new 0.10 behavior
 * — no auth call site needed to change.
 */
@Catch(TooManyAttemptsException)
export class RateLimitExceptionFilter implements ExceptionFilter {
  catch(exception: TooManyAttemptsException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
