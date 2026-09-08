import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MIGRATION_QUEUE } from '../queue/queue.constants';
import { EmployeesModule } from '../employees/employees.module';
import { LeaveModule } from '../leave/leave.module';
import { ColumnMappingTemplateService } from './column-mapping-template.service';
import { ImportBatchService } from './import-batch.service';
import { AttendanceHistoryImporter } from './importers/attendance-history.importer';
import { BranchImporter } from './importers/branch.importer';
import { CostCenterImporter } from './importers/cost-center.importer';
import { DepartmentImporter } from './importers/department.importer';
import { DesignationImporter } from './importers/designation.importer';
import { EmployeeImporter } from './importers/employee.importer';
import { ImporterRegistry } from './importers/importer-registry';
import { LeaveBalanceImporter } from './importers/leave-balance.importer';
import { PayslipHistoryImporter } from './importers/payslip-history.importer';
import { MigrationController } from './migration.controller';
import { MigrationProcessingService } from './migration-processing.service';
import { MigrationProcessor } from './migration.processor';
import { MigrationPurgeService } from './migration-purge.service';

/**
 * The data migration & onboarding toolkit (step 3.5.1) — see
 * docs/conventions/data-migration.md. Imports `EmployeesModule` (for
 * `EmployeeService`, already exported) and `LeaveModule` (for
 * `LeaveBalanceService`, additively exported this step) so the EMPLOYEE and
 * LEAVE_BALANCE importers route through the REAL modules rather than
 * reimplementing any validation — the same "consumer imports the reused
 * module" direction 3.1's Expense->Payroll `ExchangeRateService` export
 * already establishes. `StorageService`/`IdempotencyService`/
 * `TenantContextService` need no explicit import — all `@Global()`.
 * `BullModule.registerQueue({name: MIGRATION_QUEUE})` is the SAME reusable
 * pattern every prior BullMQ-backed module already established — see
 * `QueueModule`'s doc comment.
 *
 * `ImportBatchService`/`ColumnMappingTemplateService`/
 * `MigrationProcessingService` are exported additively so
 * `PlatformMigrationModule` (the vendor-console onboarding surface, see
 * docs/conventions/vendor-console.md) can drive the exact same batches/
 * importers on a tenant's behalf, never a parallel implementation.
 */
@Module({
  imports: [
    EmployeesModule,
    LeaveModule,
    BullModule.registerQueue({
      name: MIGRATION_QUEUE,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    }),
  ],
  controllers: [MigrationController],
  providers: [
    ImportBatchService,
    ColumnMappingTemplateService,
    MigrationProcessingService,
    MigrationProcessor,
    MigrationPurgeService,
    ImporterRegistry,
    BranchImporter,
    DepartmentImporter,
    DesignationImporter,
    CostCenterImporter,
    EmployeeImporter,
    LeaveBalanceImporter,
    AttendanceHistoryImporter,
    PayslipHistoryImporter,
  ],
  exports: [ImportBatchService, ColumnMappingTemplateService, MigrationProcessingService, MigrationPurgeService],
})
export class MigrationModule {}
