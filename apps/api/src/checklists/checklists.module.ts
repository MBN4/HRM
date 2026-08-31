import { Module } from '@nestjs/common';
import { ChecklistService } from './checklist.service';
import { ChecklistTemplateService } from './checklist-template.service';

/**
 * The shared, generic checklist mini-engine (step 2.3) — see
 * docs/conventions/recruitment-lifecycle.md. No controller of its own:
 * Onboarding and Offboarding each expose their OWN checklist routes
 * (`onboarding.manage`/`offboarding.manage`-gated respectively, with their
 * own fixed `processType`), both importing this module to inject
 * `ChecklistService`/`ChecklistTemplateService` directly — the same
 * "shared provider module, no shared controller" shape `WorkflowModule`
 * takes for every consumer that needs its OWN routing/permission gating
 * around the same underlying engine.
 */
@Module({
  providers: [ChecklistService, ChecklistTemplateService],
  exports: [ChecklistService, ChecklistTemplateService],
})
export class ChecklistsModule {}
