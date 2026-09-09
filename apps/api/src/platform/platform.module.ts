import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PasswordService } from '../auth/password.service';
import { BillingModule } from '../billing/billing.module';
import { BrandingModule } from '../branding/branding.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { PlatformAdminController } from './admins/platform-admin.controller';
import { PlatformAdminService } from './admins/platform-admin.service';
import { PlatformAuditController } from './audit/platform-audit.controller';
import { PlatformAuditQueryService } from './audit/platform-audit-query.service';
import { PlatformAuditRecordService } from './audit/platform-audit-record.service';
import { PlatformAuthContextModule } from './auth/platform-auth-context.module';
import { PlatformAuthController } from './auth/platform-auth.controller';
import { PlatformAuthService } from './auth/platform-auth.service';
import { PlatformMfaService } from './auth/platform-mfa.service';
import { PlatformBillingController } from './billing/platform-billing.controller';
import { PlatformBillingService } from './billing/platform-billing.service';
import { PlatformBrandingController } from './branding/platform-branding.controller';
import { PlatformBrandingService } from './branding/platform-branding.service';
import { PlatformCountryPackController } from './country-packs/platform-country-pack.controller';
import { PlatformCountryPackService } from './country-packs/platform-country-pack.service';
import { PlatformImpersonationController } from './impersonation/platform-impersonation.controller';
import { PlatformImpersonationService } from './impersonation/platform-impersonation.service';
import { MigrationModule } from '../migration/migration.module';
import { PlatformMigrationController } from './migration/platform-migration.controller';
import { PlatformMigrationService } from './migration/platform-migration.service';
import { PlatformTenantController } from './tenants/platform-tenant.controller';
import { PlatformTenantService } from './tenants/platform-tenant.service';
import { PlatformUsageController } from './usage/platform-usage.controller';
import { PlatformUsageService } from './usage/platform-usage.service';

/**
 * The vendor super-admin console's backend (step 4.1) — see
 * docs/conventions/vendor-console.md. Everything here runs on the
 * `@PlatformRoute()` seam (0.3) — cross-tenant by construction, the
 * single most dangerous surface in this system, locked down accordingly:
 * mandatory MFA (`platform/auth`), least-privilege platform roles
 * (`PlatformPermissionsGuard` + `@RequirePlatformPermissions()` on every
 * route below), and every action audited (`PlatformAuditRecordService` +,
 * for tenant-targeted actions, the EXISTING `AuditRecordService`).
 *
 * Imports `PlatformAuthContextModule` (already imported by `TenancyModule`
 * for the interceptor's own authentication branch) rather than
 * re-registering `PlatformTokenService` — the SAME instance signs tokens
 * here and verifies them there. Imports `AuthModule` for the EXISTING
 * `TokenService` (impersonation access tokens are ordinary TENANT tokens
 * with two extra claims, signed with the SAME `JWT_SECRET` tenant login
 * already uses — see `TokenService.signImpersonationAccessToken`).
 * `PasswordService` is registered locally (a second, stateless
 * registration) rather than exported from `AuthModule`, the same small,
 * accepted duplication `tenancy.module.ts`/`auth.module.ts` already take
 * for their own near-identical `JwtModule` registrations.
 */
@Module({
  // BillingModule (4.2) — reused for BillingService (customer/subscription
  // sync, invoice/payment-method serialization) so PlatformBillingService
  // never re-implements the Stripe-object-to-row mapping.
  // BrandingModule (4.3) — reused for BrandingResolutionService (cache
  // invalidation on a platform-triggered reset)/DomainVerificationService/
  // CERT_PROVIDER so PlatformBrandingService never re-implements DNS/TLS
  // provisioning a second time.
  // MigrationModule (3.5.1) — reused for `ImportBatchService` so
  // `PlatformMigrationService` never re-implements upload/dry-run/commit
  // orchestration a second time. See docs/conventions/data-migration.md.
  imports: [PlatformAuthContextModule, AuthModule, BillingModule, BrandingModule, MigrationModule, CountryPacksModule],
  controllers: [
    PlatformAuthController,
    PlatformAdminController,
    PlatformTenantController,
    PlatformCountryPackController,
    PlatformUsageController,
    PlatformImpersonationController,
    PlatformAuditController,
    PlatformBillingController,
    PlatformBrandingController,
    PlatformMigrationController,
  ],
  providers: [
    PasswordService,
    PlatformMfaService,
    PlatformAuthService,
    PlatformAuditRecordService,
    PlatformAdminService,
    PlatformTenantService,
    PlatformCountryPackService,
    PlatformUsageService,
    PlatformImpersonationService,
    PlatformAuditQueryService,
    PlatformBillingService,
    PlatformBrandingService,
    PlatformMigrationService,
  ],
  exports: [PlatformAuditRecordService],
})
export class PlatformModule {}
