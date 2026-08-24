import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { firstValueFrom, Observable, of } from 'rxjs';
import { withTenantContext } from '@hrm/db';
import { IS_PUBLIC_KEY } from './public.decorator';
import { IS_PLATFORM_KEY } from './platform-route.decorator';
import { TenantResolutionService } from './tenant-resolution.service';
import { RequestTenantStore } from './tenant-context.store';
import { TenantContextService } from './tenant-context.service';

const EMPTY_CONTEXT: Omit<RequestTenantStore, 'platform' | 'tx'> = {
  tenantId: null,
  branchId: null,
  userId: null,
  roles: null,
};

/**
 * Applied globally (see tenancy.module.ts). For every HTTP request, in
 * order:
 *
 *   1. `@Public()` routes skip resolution entirely — no tenant, no
 *      transaction.
 *   2. `@PlatformRoute()` routes require `PLATFORM_MODE_ENABLED=true` or are
 *      rejected; even enabled, they get no transaction (see
 *      platform-route.decorator.ts) — there is no bypass to open one with
 *      yet.
 *   3. Everything else goes through `TenantResolutionService`. Unresolvable
 *      -> 401. Resolved -> the ENTIRE rest of the request (remaining
 *      interceptors, pipes, the controller method) runs inside one
 *      `withTenantContext` transaction, so RLS is enforced for every query
 *      the handler makes, not just ones it happens to wrap itself.
 *
 * The transaction is bridged to the handler via `TenantContextService`'s
 * AsyncLocalStorage, not Nest's REQUEST-scoped DI — see
 * tenant-context.store.ts for why.
 *
 * Known tradeoff: holding one Postgres transaction open for a request's
 * full duration means a slow handler (e.g. an outbound HTTP call) holds a
 * pooled connection the whole time. Acceptable for now — this is what makes
 * "RLS is enforced for the whole request lifecycle" true — but worth
 * revisiting under 0.10 (resilience) if it becomes a real bottleneck (e.g.
 * a request-level timeout, or narrowing which handlers actually need it).
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolutionService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return this.tenantContext.run({ ...EMPTY_CONTEXT, platform: false, tx: null }, () => next.handle());
    }

    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPlatform) {
      if (this.config.get<string>('PLATFORM_MODE_ENABLED') !== 'true') {
        throw new ForbiddenException('Platform mode is not enabled.');
      }
      return this.tenantContext.run({ ...EMPTY_CONTEXT, platform: true, tx: null }, () => next.handle());
    }

    const req = context.switchToHttp().getRequest<Request>();
    const resolved = await this.resolver.resolve(req);
    if (!resolved) {
      throw new UnauthorizedException('Unable to resolve a tenant for this request.');
    }

    const result = await withTenantContext(resolved.tenantId, (tx) =>
      this.tenantContext.run(
        { tenantId: resolved.tenantId, branchId: null, userId: null, roles: null, platform: false, tx },
        // `next.handle()` returns an Observable representing the rest of the
        // pipeline (remaining interceptors + the controller method).
        // Converting it to a promise here is what makes the transaction
        // actually wait for the handler to finish before committing —
        // awaiting an Observable directly would resolve immediately with
        // the Observable itself, closing the transaction before the
        // controller ever runs.
        () => firstValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );

    return of(result);
  }
}
