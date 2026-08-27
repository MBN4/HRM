import { ArgumentsHost, Catch, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@hrm/db';
import type { Response } from 'express';

const POOL_TIMEOUT_ERROR_CODE = 'P2024';
const POOL_EXHAUSTION_RETRY_AFTER_SECONDS = 2;

/**
 * Connection-pool exhaustion protection (step 0.10) — see /CLAUDE.md §
 * Conventions → Connection-pool protection. Prisma throws
 * `PrismaClientKnownRequestError` with code `P2024` ("Timed out fetching a
 * new connection from the pool") when every pooled connection is checked
 * out and `pool_timeout` (see `packages/db/src/pool-config.ts`) elapses
 * before one frees up. Without this filter, that error would surface as a
 * generic, confusing `500`; this catches SPECIFICALLY that code and turns
 * it into a clean `503` with `Retry-After` — the actual backpressure
 * signal this step's brief asks for ("connection-pool exhaustion returns
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
  constructor(httpAdapterHost: HttpAdapterHost) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    if (exception.code !== POOL_TIMEOUT_ERROR_CODE) {
      super.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(POOL_EXHAUSTION_RETRY_AFTER_SECONDS));
    const serviceUnavailable = new ServiceUnavailableException(
      'The service is temporarily at capacity (database connection pool exhausted). Please retry shortly.',
    );
    response.status(serviceUnavailable.getStatus()).json(serviceUnavailable.getResponse());
  }
}
