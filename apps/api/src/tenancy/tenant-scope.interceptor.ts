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
import { appPrisma, Prisma, withTenantContext } from '@hrm/db';
import { DEFAULT_REQUEST_PRIORITY, RequestPriority } from '@hrm/shared';
import { ApiKeyAuthService } from '../auth/api-key/api-key-auth.service';
import { ApiKeyRateLimitService } from '../auth/api-key/api-key-rate-limit.service';
import { IS_ALLOW_ANONYMOUS_KEY } from '../auth/decorators/allow-anonymous.decorator';
import { PermissionsCacheService } from '../auth/permissions-cache.service';
import { LoadSheddingService } from '../resilience/load-shedding/load-shedding.service';
import { PRIORITY_KEY } from '../resilience/load-shedding/priority.decorator';
import { TenantRateLimitService } from '../resilience/rate-limit/tenant-rate-limit.service';
import { IS_ALLOW_ANONYMOUS_PLATFORM_KEY } from '../platform/auth/allow-anonymous-platform.decorator';
import { PlatformAuthContextService } from '../platform/auth/platform-auth-context.service';
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
  platformAdminId: null,
  platformRole: null,
  impersonatedByPlatformAdminId: null,
};

/** Requests are blocked entirely (not just billing-gated) for a tenant in either of these states — see docs/conventions/vendor-console.md → Tenant lifecycle. */
const BLOCKED_TENANT_STATUSES = new Set(['SUSPENDED', 'CANCELLED']);

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  /**
   * Step 4.1 — present ONLY on an impersonation access token (minted by
   * `PlatformImpersonationService` via `TokenService.signImpersonationAccessToken`):
   * the REAL platform admin's id. `sub` is still the impersonated tenant
   * user's id, so every other authentication step below is unchanged.
   */
  impersonatedBy?: string;
  impersonationSessionId?: string;
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

/** Step 3.3 — the versioned public API's credential header, distinct from `Authorization: Bearer`. */
const API_KEY_HEADER_NAME = 'x-api-key';

function extractApiKey(req: Request): string | null {
  const header = req.headers[API_KEY_HEADER_NAME];
  return typeof header === 'string' && header.length > 0 ? header : null;
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
    private readonly apiKeyAuth: ApiKeyAuthService,
    private readonly apiKeyRateLimit: ApiKeyRateLimitService,
    private readonly platformAuth: PlatformAuthContextService,
    private readonly permissionsCache: PermissionsCacheService,
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

      // Step 4.1 — the vendor super-admin console. Every @PlatformRoute()
      // request now requires a fully authenticated, MFA-verified
      // PlatformAdmin UNLESS the route is explicitly @AllowAnonymousPlatform()
      // (login / MFA enroll+verify / refresh — the handful of routes that
      // themselves establish a platform session). This is the fix for what
      // was, through 0.6/0.10, a genuine gap: PLATFORM_MODE_ENABLED alone
      // let ANY caller reach a platform route with no identity check at
      // all. See docs/conventions/vendor-console.md.
      const isAllowAnonymousPlatform = this.reflector.getAllAndOverride<boolean>(IS_ALLOW_ANONYMOUS_PLATFORM_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isAllowAnonymousPlatform) {
        return this.tenantContext.run({ ...EMPTY_CONTEXT, platform: true, tx: null }, () =>
          firstValueFrom(next.handle(), { defaultValue: undefined }),
        );
      }

      const platformReq = context.switchToHttp().getRequest<Request>();
      const token = extractBearerToken(platformReq);
      const authenticated = token ? await this.platformAuth.authenticate(token) : null;
      if (!authenticated) {
        throw new UnauthorizedException('A valid, MFA-verified platform admin session is required.');
      }

      return this.tenantContext.run(
        {
          ...EMPTY_CONTEXT,
          platform: true,
          tx: null,
          platformAdminId: authenticated.platformAdminId,
          platformRole: authenticated.role,
        },
        () => firstValueFrom(next.handle(), { defaultValue: undefined }),
      );
    }

    const req = context.switchToHttp().getRequest<Request>();

    // Step 3.3 — the versioned public API's SECOND, parallel authentication
    // path: an `X-Api-Key` header authenticates AND resolves the tenant in
    // one step (the key itself embeds which tenant it belongs to), so
    // host/subdomain-based TenantResolutionService below is skipped
    // entirely for this path — a generic API client has no tenant
    // subdomain to call. Still opens the SAME `withTenantContext`
    // transaction as every other request, so RLS is enforced identically.
    const apiKey = extractApiKey(req);
    if (apiKey) {
      return this.handleApiKeyRequest(apiKey, next);
    }

    const resolved = await this.resolver.resolve(req);
    if (!resolved) {
      throw new UnauthorizedException('Unable to resolve a tenant for this request.');
    }
    // Step 4.1 — TENANT_STATUS is now enforced (flagged as deliberately
    // NOT checked back in 0.3/0.6): a SUSPENDED/CANCELLED tenant's users
    // are blocked entirely, before rate limiting or the DB transaction
    // even opens. Suspend/resume is the vendor-console lever for this —
    // see docs/conventions/vendor-console.md → Tenant lifecycle.
    if (BLOCKED_TENANT_STATUSES.has(resolved.tenant.status)) {
      throw new ForbiddenException('This tenant account is suspended.');
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
   * Step 3.3 — validates `X-Api-Key`, enforces BOTH the per-tenant AND the
   * per-key rate limit (same "no single layer trusted alone" posture as
   * everywhere else), then runs the rest of the request inside the SAME
   * `withTenantContext` transaction the JWT path uses. `roles: []` (an API
   * key has no role membership of its own) and `permissions: scopes` —
   * `PermissionsGuard` needs no changes at all to enforce a key's scopes:
   * it already just reads `TenantContextService.getPermissions()`.
   */
  private async handleApiKeyRequest(rawKey: string, next: CallHandler): Promise<unknown> {
    const validated = await this.apiKeyAuth.validate(rawKey);
    if (!validated) {
      throw new UnauthorizedException('Invalid, expired, or revoked API key.');
    }

    // Step 4.1 — TENANT_STATUS applies to the API-key path too, same as
    // the JWT/subdomain path above.
    const tenant = await appPrisma.tenant.findUnique({ where: { id: validated.tenantId }, select: { status: true } });
    if (!tenant || BLOCKED_TENANT_STATUSES.has(tenant.status)) {
      throw new ForbiddenException('This tenant account is suspended.');
    }

    await this.tenantRateLimit.enforce(validated.tenantId);
    await this.apiKeyRateLimit.enforce(validated.apiKeyId, validated.rateLimitPerMinute);

    return withTenantContext(validated.tenantId, async (tx) => {
      const apiKeyContext: Omit<RequestTenantStore, 'platform' | 'tx'> = {
        tenantId: validated.tenantId,
        branchId: null,
        userId: null,
        roles: [],
        permissions: validated.scopes,
        branchIds: null,
        platformAdminId: null,
        platformRole: null,
        impersonatedByPlatformAdminId: null,
      };
      return this.tenantContext.run({ ...apiKeyContext, platform: false, tx }, () =>
        firstValueFrom(next.handle(), { defaultValue: undefined }),
      );
    });
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

    // Step 4.1 — an impersonation access token carries `impersonatedBy` +
    // `impersonationSessionId` on top of the ordinary `{sub, tenantId}`
    // shape. The session itself is the SOURCE OF TRUTH for whether this
    // token is still good: it must exist, target THIS user, not have been
    // manually ended, and not have expired — checked fresh on every
    // request (not just trusted from the token's own `exp`, which is set
    // to match but is a second, independent check, this codebase's usual
    // "no single layer trusted alone" posture). A suspended/deleted
    // PlatformAdmin is already excluded structurally: the token was only
    // ever minted for an admin who passed PlatformImpersonationService's
    // own permission check at session-start time, and ending a session
    // (or it expiring) is the only thing that revokes it — there is no
    // separate platform-admin-status re-check here, matching how an
    // ordinary tenant token doesn't re-check the platform layer either.
    let impersonatedByPlatformAdminId: string | null = null;
    if (payload.impersonatedBy && payload.impersonationSessionId) {
      const session = await tx.impersonationSession.findUnique({
        where: { tenantId_id: { tenantId, id: payload.impersonationSessionId } },
      });
      const valid =
        session &&
        session.targetUserId === user.id &&
        session.platformAdminId === payload.impersonatedBy &&
        !session.endedAt &&
        session.expiresAt.getTime() > Date.now();
      if (!valid) {
        throw unauthorized();
      }
      impersonatedByPlatformAdminId = payload.impersonatedBy;
    }

    // Phase 5.1 (see docs/conventions/scaling-data-layer.md) — cached: this
    // runs on EVERY authenticated request, the hottest resolve-fresh read
    // in the system. See PermissionsCacheService's own doc comment for the
    // short-TTL/no-mutation-endpoint-yet honesty note.
    const { roles, permissions, branchIds } = await this.permissionsCache.getContext(tx, tenantId, user.id);

    return {
      tenantId,
      userId: user.id,
      roles,
      permissions,
      branchIds,
      branchId: branchIds?.[0] ?? null,
      platformAdminId: null,
      platformRole: null,
      impersonatedByPlatformAdminId,
    };
  }
}
