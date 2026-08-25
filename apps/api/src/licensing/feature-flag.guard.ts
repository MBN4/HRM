import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { FeatureFlagKey } from '@hrm/shared';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { FeatureFlagResolutionService } from './feature-flag-resolution.service';
import { REQUIRE_FEATURE_KEY } from './require-feature.decorator';

/**
 * Enforces `@RequireFeature(...)` — deny by default: a route with the
 * decorator rejects (403) unless the caller's tenant currently resolves
 * every listed flag.
 *
 * Implemented as a `NestInterceptor`, applied via
 * `@UseInterceptors(FeatureFlagGuard)`, for the exact same reason
 * `PermissionsGuard` is (see /CLAUDE.md § Conventions → RBAC): Nest runs
 * ALL guards, for every request, strictly before ANY interceptor — but
 * this check needs `TenantContextService.getTx()`, which only exists once
 * `TenantScopeInterceptor` (itself a global interceptor) has already run.
 * A real `CanActivate` here would run too early and could never get a
 * transaction to query through.
 *
 * Unlike `PermissionsGuard` (which reads a permission set
 * `TenantScopeInterceptor` already loaded into the request context), this
 * queries `FeatureFlagResolutionService` fresh on every gated request —
 * entitlement resolution is comparatively rare (only routes that declare
 * `@RequireFeature` pay for it) and, in lifetime mode, MUST be fresh every
 * time (see LicenseVerificationService) rather than cached in the request
 * context the way permissions are.
 */
@Injectable()
export class FeatureFlagGuard implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    private readonly resolution: FeatureFlagResolutionService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const required = this.reflector.getAllAndOverride<FeatureFlagKey[]>(REQUIRE_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required && required.length > 0) {
      const tenantId = this.tenantContext.tenantId;
      if (!tenantId) {
        throw new ForbiddenException('No tenant context is bound to this request.');
      }

      const tx = this.tenantContext.getTx();
      const { flags } = await this.resolution.resolve(tx, tenantId);
      const missing = required.filter((flag) => !flags.includes(flag));
      if (missing.length > 0) {
        throw new ForbiddenException(`Feature(s) not enabled for this tenant: ${missing.join(', ')}.`);
      }
    }

    return next.handle();
  }
}
