import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { BrandingController } from './branding.controller';
import { BrandingResolutionService } from './branding-resolution.service';
import { BrandingService } from './branding.service';
import { CERT_PROVIDER } from './cert/cert-provider.interface';
import { MockCertProvider } from './cert/mock-cert.provider';
import { AcmeCertProvider } from './cert/acme-cert.provider';
import { DomainVerificationService } from './domain-verification.service';

/**
 * White-label / branding (step 4.3) — see docs/conventions/white-label.md.
 * `RedisModule`/`StorageModule`/`TenancyModule` are `@Global()`, so
 * `BrandingResolutionService`/`BrandingService`/`BrandingController` need
 * no explicit import for `REDIS_CLIENT`/`StorageService`/
 * `TenantContextService` to resolve — only `LicensingModule` (not global)
 * is imported explicitly, for `FeatureFlagResolutionService`/
 * `FeatureFlagGuard` (the full-rebrand entitlement gate).
 *
 * Exports `BrandingResolutionService` (so `PlatformModule`'s
 * `PlatformBrandingService` can invalidate the cache after an oversight
 * action) and `DomainVerificationService`/`CERT_PROVIDER` (so
 * `PlatformBrandingService` can drive domain verification/TLS
 * provisioning) — Nest module exports are NOT transitive (see
 * docs/conventions/billing.md's own DI-export bug writeup), so every
 * provider a future importer needs must be listed here explicitly.
 */
@Module({
  imports: [LicensingModule],
  controllers: [BrandingController],
  providers: [
    BrandingResolutionService,
    BrandingService,
    DomainVerificationService,
    {
      provide: CERT_PROVIDER,
      useClass: process.env.ACME_ENABLED === 'true' ? AcmeCertProvider : MockCertProvider,
    },
  ],
  exports: [BrandingResolutionService, BrandingService, DomainVerificationService, CERT_PROVIDER],
})
export class BrandingModule {}
