import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { ChecklistsModule } from '../checklists/checklists.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingOfferAcceptedListener } from './onboarding-offer-accepted.listener';

/**
 * The Onboarding module (step 2.3) — see
 * docs/conventions/recruitment-lifecycle.md. Imports `EmployeesModule` to
 * inject the REAL, UNMODIFIED 1.1 `EmployeeService` directly (the
 * candidate -> Employee conversion IS a plain `EmployeeService.create`
 * call, with zero new validation logic) and `ChecklistsModule` for the
 * shared checklist mini-engine. Deliberately does NOT import
 * `RecruitmentModule` — the only connection between the two modules is
 * `OnboardingOfferAcceptedListener` reacting to the `recruitment.
 * offer_accepted` domain event, never a direct service dependency.
 */
@Module({
  imports: [EmployeesModule, ChecklistsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, OnboardingOfferAcceptedListener],
  exports: [OnboardingService],
})
export class OnboardingModule {}
