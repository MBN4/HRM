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
 *
 * **Deliberately NOT cached, despite being flagged as a caching candidate
 * in Phase 5.1** (see docs/conventions/scaling-data-layer.md § Caching —
 * "Entitlement — considered, deliberately not cached" for the full
 * write-up). A cached wrapper was built and wired in during that step,
 * then reverted after the EXISTING `licensing-saas.e2e-spec.ts` suite
 * caught it serving a STALE (pre-subscription-change) resolution whenever
 * a `Subscription`/`License`/`TenantFeatureFlagOverride` row is written
 * through any path other than the two hook points a cache could
 * realistically invalidate from — which real tests (and, by the same
 * logic, real future code) legitimately do. This is exactly the failure
 * mode white-label.md's own `showPoweredBy` write-up already warned this
 * class of check against; the revert is the direct, empirical
 * confirmation of that warning, not a theoretical one.
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
