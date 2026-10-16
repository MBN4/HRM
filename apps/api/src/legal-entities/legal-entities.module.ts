import { Module } from '@nestjs/common';
import { LegalEntityController } from './legal-entity.controller';
import { LegalEntityService } from './legal-entity.service';

/**
 * Multi-legal-entity identity (step 12.1) — see docs/conventions/legal-entities.md. The identity
 * RESOLUTION lives in plain functions (`legal-entity-identity.util.ts`, imported directly by payroll /
 * statutory reporting / e-signature — the same shape `payroll-pack.util.ts` takes, so context-less
 * BullMQ processors can use it too); this module only owns the admin CRUD surface.
 */
@Module({
  controllers: [LegalEntityController],
  providers: [LegalEntityService],
})
export class LegalEntitiesModule {}
