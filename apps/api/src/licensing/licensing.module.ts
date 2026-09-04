import { Module } from '@nestjs/common';
import { FeatureFlagResolutionService } from './feature-flag-resolution.service';
import { FeatureFlagGuard } from './feature-flag.guard';
import { LicenseActivationService } from './license-activation.service';
import { LicenseSigningService } from './license-signing.service';
import { LicenseVerificationService } from './license-verification.service';
import { LicensingAdminController } from './licensing-admin.controller';
import { LicensingAdminService } from './licensing-admin.service';
import { LicensingController } from './licensing.controller';
import { SeatCapService } from './seat-cap.service';

@Module({
  controllers: [LicensingController, LicensingAdminController],
  providers: [
    FeatureFlagResolutionService,
    FeatureFlagGuard,
    LicenseSigningService,
    LicenseVerificationService,
    LicenseActivationService,
    LicensingAdminService,
    SeatCapService,
  ],
  // SeatCapService exported since step 4.2 — BillingModule reuses
  // `countActive` as THE seat-counting definition for Stripe quantity
  // metering (see that service's own doc comment).
  exports: [FeatureFlagResolutionService, FeatureFlagGuard, SeatCapService],
})
export class LicensingModule {}
