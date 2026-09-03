import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { PLATFORM_ROLE_PERMISSIONS, PlatformRoleNameKey } from '@hrm/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { REQUIRE_PLATFORM_PERMISSIONS_KEY } from '../decorators/require-platform-permissions.decorator';

/**
 * Enforces `@RequirePlatformPermissions(...)` — the platform-context
 * sibling of `PermissionsGuard` (0.4). Implemented as a `NestInterceptor`
 * for the identical reason: Nest runs every guard before any interceptor,
 * and the authenticated platform admin's role isn't known until
 * `TenantScopeInterceptor`'s own interceptor-phase authentication has run.
 * A route with NO `@RequirePlatformPermissions()` at all still requires a
 * fully authenticated platform admin (enforced by the interceptor itself,
 * unless `@AllowAnonymousPlatform()`) — this guard only adds the
 * least-privilege ROLE check on top.
 */
@Injectable()
export class PlatformPermissionsGuard implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRE_PLATFORM_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required && required.length > 0) {
      const role = this.tenantContext.getStore()?.platformRole as PlatformRoleNameKey | null | undefined;
      const granted = role ? (PLATFORM_ROLE_PERMISSIONS[role] ?? []) : [];
      const missing = required.filter((permission) => !granted.includes(permission as never));
      if (missing.length > 0) {
        throw new ForbiddenException(`Missing required platform permission(s): ${missing.join(', ')}.`);
      }
    }

    return next.handle();
  }
}
