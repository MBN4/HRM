import { SetMetadata } from '@nestjs/common';
import type { FeatureFlagKey } from '@hrm/shared';

export const REQUIRE_FEATURE_KEY = 'hrm:requiredFeatures';

/**
 * Gates a route (or, applied at the class level, a whole controller)
 * behind one or more feature flags — deny-by-default: the caller's tenant
 * must have EVERY listed flag in its currently resolved entitlement
 * (`FeatureFlagResolutionService`) or the request is rejected with 403.
 * Enforced by `FeatureFlagGuard` — see that file for why it's applied via
 * `@UseInterceptors()` despite the name, same reasoning as
 * `@RequirePermissions()` + `PermissionsGuard` (/CLAUDE.md § Conventions →
 * RBAC).
 *
 * Usage:
 * ```ts
 * @Get('reports/advanced')
 * @UseInterceptors(FeatureFlagGuard)
 * @RequireFeature(FEATURE_FLAGS.ADVANCED_REPORTING)
 * getAdvancedReport() { ... }
 * ```
 */
export const RequireFeature = (...flags: FeatureFlagKey[]) => SetMetadata(REQUIRE_FEATURE_KEY, flags);
