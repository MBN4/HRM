import { Module } from '@nestjs/common';
import { EmployeesModule } from '../../employees/employees.module';
import { LeaveModule } from '../../leave/leave.module';
import { LicensingModule } from '../../licensing/licensing.module';
import { V1EmployeesController } from './v1-employees.controller';
import { V1LeaveController } from './v1-leave.controller';

/**
 * The versioned public REST surface (step 3.3) — deliberately a CURATED,
 * representative slice (employees + leave), not a mirror of every internal
 * route: proving the API-key auth path, per-key scoping, per-key rate
 * limiting, tenant isolation, and OpenAPI generation end to end is this
 * step's job; growing this to cover every module is ordinary, incremental
 * work for whenever a real integration actually needs a given resource —
 * the SAME "documented, deliberate scope boundary" posture this codebase
 * takes everywhere (e.g. payroll's single bank-export format). Imports
 * `EmployeesModule`/`LeaveModule` to reuse their SERVICES directly — this
 * module owns zero new business logic, only routing + OpenAPI annotation.
 */
@Module({
  imports: [EmployeesModule, LeaveModule, LicensingModule],
  controllers: [V1EmployeesController, V1LeaveController],
})
export class V1Module {}
