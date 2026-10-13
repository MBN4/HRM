import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkingHoursModule } from '../working-hours/working-hours.module';
import { MyScheduleService } from './my-schedule.service';
import { RosterGridService } from './roster-grid.service';
import { RosterWriteService } from './roster-write.service';
import { RosterService } from './roster.service';
import { SchedulingController } from './scheduling.controller';
import { SchedulingScopeService } from './scheduling-scope.service';
import { ShiftSwapService } from './shift-swap.service';
import { ShiftSwapWorkflowEventsListener } from './shift-swap-workflow-events.listener';
import { StandingShiftService } from './standing-shift.service';

/**
 * Shift scheduling & rostering (step 8.2) — see docs/conventions/shift-scheduling.md. An ADDITIVE
 * layer over the existing attendance `ShiftDefinition`/`RosterAssignment` (reused, not replaced)
 * and the 8.1 working-hours resolver (the single source of "what hours apply"): this module only
 * adds the standing-assignment API, the dated roster calendar, publish, coverage, "my schedule"
 * and swap-via-workflow. Attendance, auth, RLS and the resolver are consumed, never rebuilt.
 */
@Module({
  imports: [AttendanceModule, WorkflowModule, WorkingHoursModule],
  controllers: [SchedulingController],
  providers: [
    SchedulingScopeService,
    StandingShiftService,
    RosterWriteService,
    RosterService,
    RosterGridService,
    MyScheduleService,
    ShiftSwapService,
    ShiftSwapWorkflowEventsListener,
  ],
  exports: [RosterWriteService],
})
export class SchedulingModule {}
