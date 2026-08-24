import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { REQUIRE_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Enforces `@RequirePermissions(...)` — deny by default: a route with the
 * decorator rejects (403) unless the caller holds every listed permission.
 *
 * Implemented as a `NestInterceptor`, not a `CanActivate` guard, even
 * though it's named and used like one (`@UseInterceptors(PermissionsGuard)`):
 * Nest runs ALL guards, for every request, strictly before ANY interceptor
 * — there is no route-scoping exception to that order. The permission set
 * this checks doesn't exist yet at guard time; it's loaded by
 * `TenantScopeInterceptor` (the global interceptor that also opens the
 * request's RLS transaction), which only runs during the interceptor
 * phase. A real `CanActivate` here would always see an empty permission
 * set and always reject. See /CLAUDE.md § Conventions → RBAC for the full
 * writeup.
 */
@Injectable()
export class PermissionsGuard implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required && required.length > 0) {
      const granted = this.tenantContext.getPermissions();
      const missing = required.filter((permission) => !granted.includes(permission));
      if (missing.length > 0) {
        throw new ForbiddenException(`Missing required permission(s): ${missing.join(', ')}.`);
      }
    }

    return next.handle();
  }
}
