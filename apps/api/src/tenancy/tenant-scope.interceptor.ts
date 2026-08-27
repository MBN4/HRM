import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Prisma, withTenantContext } from '@hrm/db';
import { DEFAULT_REQUEST_PRIORITY, RequestPriority } from '@hrm/shared';
import { IS_ALLOW_ANONYMOUS_KEY } from '../auth/decorators/allow-anonymous.decorator';
import { loadUserContext } from '../auth/load-user-context.util';
import { LoadSheddingService } from '../resilience/load-shedding/load-shedding.service';
import { PRIORITY_KEY } from '../resilience/load-shedding/priority.decorator';
import { TenantRateLimitService } from '../resilience/rate-limit/tenant-rate-limit.service';
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
  permissions: null,
  branchIds: null,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface AccessTokenPayload {
  sub: string;
  tenantId: string;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') {
    return null;
  }
  return token;
}

/**
 * Applied globally (see tenancy.module.ts). For every HTTP request, in
 * order:
 *
 *   0. LOAD SHEDDING (step 0.10 — see /CLAUDE.md § Conventions → Load
 *      shedding) runs FIRST, before anything below, including `@Public()`/
 *      `@PlatformRoute()` detection: a shed request never resolves a
 *      tenant, never opens a DB transaction, never does ANY work beyond
 *      reading its route's `@Priority()`. This — and the REQUEST TIMEOUT
 *      wrapping the whole method below — are called directly from HERE
 *      rather than registered as separate global `APP_INTERCEPTOR`s: an
 *      earlier version of this step tried exactly that and was PROVEN
 *      WRONG by `apps/api/test/resilience.e2e-spec.ts`'s ordering test —
 *      NestJS does not reliably order `APP_INTERCEPTOR`s registered in
 *      DIFFERENT modules by `imports` array position, so a
 *      separately-registered interceptor ended up nested INSIDE this one
 *      instead of wrapping it. Calling both directly from this single
 *      global interceptor guarantees the ordering by construction — the
 *      same reasoning 0.4 documents for why auth lives here instead of a
 *      second global interceptor, extended to load shedding, the request
 *      timeout, and (per-tenant rate limiting) below.
 *   1. `@Public()` routes skip tenant resolution entirely — no tenant, no
 *      transaction, no auth. Still shedable/timeboxed by step 0 above.
 *   2. `@PlatformRoute()` routes require `PLATFORM_MODE_ENABLED=true` or are
 *      rejected; even enabled, they get no transaction (see
 *      platform-route.decorator.ts) — there is no bypass to open one with
 *      yet.
 *   3. Everything else goes through `TenantResolutionService`. Unresolvable
 *      -> 401. Resolved -> `TenantRateLimitService.enforce(tenantId)` runs
 *      NEXT, still BEFORE the transaction opens (step 0.10): a tenant over
 *      its quota gets a 429 without ever checking out a pooled DB
 *      connection. Only then does the ENTIRE rest of the request
 *      (remaining interceptors, pipes, the controller method) run inside
 *      one `withTenantContext` transaction, so RLS is enforced for every
 *      query the handler makes, not just ones it happens to wrap itself.
 *   4. Within that transaction, unless the route is `@AllowAnonymous()`
 *      (login/refresh/reset — they need a tenant, not a token), the
 *      request's `Authorization: Bearer` JWT is verified and the user's
 *      current roles/permissions/branch-scope are loaded fresh from the DB
 *      — through the SAME transaction, so those lookups are RLS-enforced
 *      too — and placed in the request context alongside `tenantId`.
 *
 * The Observable from `next.handle()` is bridged into a Promise via
 * `firstValueFrom` throughout (awaiting the Observable directly would
 * resolve instantly with the Observable object itself) — this whole
 * method now builds ONE Promise for the entire request (see `handle()`)
 * and wraps IT with the load-shedding release and the request timeout,
 * converting back to an Observable only at the very end.
 *
 * Known tradeoffs, both DOCUMENTED not hidden (see /CLAUDE.md §
 * Conventions → Connection-pool protection / Graceful degradation +
 * health for the full write-up):
 *   - Holding one Postgres transaction open for a request's full duration
 *     means a slow handler holds a pooled connection the whole time —
 *     0.10's bounded pool + `pool_timeout` + `DbPoolExhaustionFilter` is
 *     what turns "exhausted" into a clean 503 instead of a hang.
 *   - The request timeout bounds how long the CALLER waits, not how long
 *     underlying async work (a Promise mid-`await`, a Postgres query
 *     already sent) actually keeps running — JS Promises aren't
 *     cancellable. The response is fast and clean either way; the
 *     resource is freed once the underlying work naturally finishes or
 *     its own timeout (e.g. `pool_timeout`) fires.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolutionService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly jwt: JwtService,
    private readonly tenantRateLimit: TenantRateLimitService,
    private readonly loadShedding: LoadSheddingService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const response = context.switchToHttp().getResponse<Response>();
    const priority =
      this.reflector.getAllAndOverride<RequestPriority | undefined>(PRIORITY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_REQUEST_PRIORITY;
    const release = this.loadShedding.admit(priority, response);

    try {
      const result = await this.withRequestTimeout(this.handle(context, next));
      return of(result);
    } finally {
      release();
    }
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return this.tenantContext.run({ ...EMPTY_CONTEXT, platform: false, tx: null }, () =>
        firstValueFrom(next.handle(), { defaultValue: undefined }),
      );
    }

    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPlatform) {
      if (this.config.get<string>('PLATFORM_MODE_ENABLED') !== 'true') {
        throw new ForbiddenException('Platform mode is not enabled.');
      }
      return this.tenantContext.run({ ...EMPTY_CONTEXT, platform: true, tx: null }, () =>
        firstValueFrom(next.handle(), { defaultValue: undefined }),
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    const resolved = await this.resolver.resolve(req);
    if (!resolved) {
      throw new UnauthorizedException('Unable to resolve a tenant for this request.');
    }

    await this.tenantRateLimit.enforce(resolved.tenantId);

    const isAllowAnonymous = this.reflector.getAllAndOverride<boolean>(IS_ALLOW_ANONYMOUS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return withTenantContext(resolved.tenantId, async (tx) => {
      const authContext = isAllowAnonymous ? EMPTY_CONTEXT : await this.authenticate(req, resolved.tenantId, tx);

      return this.tenantContext.run(
        { ...authContext, tenantId: resolved.tenantId, platform: false, tx },
        () => firstValueFrom(next.handle(), { defaultValue: undefined }),
      );
    });
  }

  private async withRequestTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = Number(this.config.get<string>('REQUEST_TIMEOUT_MS') ?? DEFAULT_REQUEST_TIMEOUT_MS);
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RequestTimeoutException('The request took too long to process.')), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Verifies the request's access token and loads the user's current
   * roles/permissions/branch-scope. Always throws the same generic
   * `UnauthorizedException` regardless of *why* — missing token, expired,
   * malformed, unknown user, inactive user, or a token minted for a
   * different tenant — so a caller learns nothing about which of those it
   * was.
   */
  private async authenticate(
    req: Request,
    tenantId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Omit<RequestTenantStore, 'platform' | 'tx'>> {
    const unauthorized = () => new UnauthorizedException('Authentication required.');

    const token = extractBearerToken(req);
    if (!token) {
      throw unauthorized();
    }

    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload>(token);
    } catch {
      throw unauthorized();
    }

    if (payload.tenantId !== tenantId) {
      throw unauthorized();
    }

    const user = await tx.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'ACTIVE') {
      throw unauthorized();
    }

    const { roles, permissions, branchIds } = await loadUserContext(tx, user.id);

    return {
      tenantId,
      userId: user.id,
      roles,
      permissions,
      branchIds,
      branchId: branchIds?.[0] ?? null,
    };
  }
}
