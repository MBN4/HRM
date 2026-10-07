import { Module } from '@nestjs/common';
import { WorkingHoursController } from './working-hours.controller';
import { WorkingHoursResolverService } from './working-hours-resolver.service';
import { WorkingHoursService } from './working-hours.service';

/**
 * Configurable working-hours policy (step 8.1, Part 1) — see
 * docs/conventions/working-hours.md. Exports the resolver so later parts
 * (day-status classification, the attendance graph) just inject it.
 */
@Module({
  controllers: [WorkingHoursController],
  providers: [WorkingHoursService, WorkingHoursResolverService],
  exports: [WorkingHoursResolverService],
})
export class WorkingHoursModule {}
