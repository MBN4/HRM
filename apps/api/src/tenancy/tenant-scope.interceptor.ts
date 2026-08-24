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
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Prisma, withTenantContext } from '@hrm/db';
import { IS_ALLOW_ANONYMOUS_KEY } from '../auth/decorators/allow-anonymous.decorator';
import { loadUserContext } from '../auth/load-user-context.util';
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
 *   1. `@Public()` routes skip resolution entirely — no tenant, no
 *      transaction, no auth.
 *   2. `@PlatformRoute()` routes require `PLATFORM_MODE_ENABLED=true` or are
 *      rejected; even enabled, they get no transaction (see
 *      platform-route.decorator.ts) — there is no bypass to open one with
 *      yet.
 *   3. Everything else goes through `TenantResolutionService`. Unresolvable
 *      -> 401. Resolved -> the ENTIRE rest of the request (remaining
 *      interceptors, pipes, the controller method) runs inside one
 *      `withTenantContext` transaction, so RLS is enforced for every query
 *      the handler makes, not just ones it happens to wrap itself.
 *   4. Within that transaction, unless the route is `@AllowAnonymous()`
 *      (login/refresh/reset — they need a tenant, not a token), the
 *      request's `Authorization: Bearer` JWT is verified and the user's
 *      current roles/permissions/branch-scope are loaded fresh from the DB
 *      — through the SAME transaction, so those lookups are RLS-enforced
 *      too — and placed in the request context alongside `tenantId`.
 *
 * Auth-context population lives here, in the same interceptor that already
 * opens the transaction, rather than as a second global interceptor:
 * `tx` only exists inside this call, so anything that needs to query
 * RLS-protected tables (User/Role/Permission/UserBranch all are) to
 * populate the context has to run here too. Two separate global
 * interceptors would make that ordering an implicit, fragile property of
 * module import order instead of a guarantee.
 *
 * The Observable from `next.handle()` is bridged into the transaction's
 * callback via `firstValueFrom` (awaiting the Observable directly would
 * resolve instantly with the Observable object itself, closing the
 * transaction before the controller ever runs).
 *
 * Known tradeoff: holding one Postgres transaction open for a request's
 * full duration means a slow handler (e.g. an outbound HTTP call) holds a
 * pooled connection the whole time. Acceptable for now — this is what makes
 * "RLS enforced for the whole request lifecycle" true — but worth
 * revisiting under 0.10 (resilience) if it becomes a real bottleneck.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolutionService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly jwt: JwtService,
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

    const isAllowAnonymous = this.reflector.getAllAndOverride<boolean>(IS_ALLOW_ANONYMOUS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const result = await withTenantContext(resolved.tenantId, async (tx) => {
      const authContext = isAllowAnonymous ? EMPTY_CONTEXT : await this.authenticate(req, resolved.tenantId, tx);

      return this.tenantContext.run(
        { ...authContext, tenantId: resolved.tenantId, platform: false, tx },
        () => firstValueFrom(next.handle(), { defaultValue: undefined }),
      );
    });

    return of(result);
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
