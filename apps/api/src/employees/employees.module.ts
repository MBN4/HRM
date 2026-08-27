import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMPLOYEE_IMPORT_QUEUE } from '../queue/queue.constants';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { EmployeeDocumentsController } from './documents/employee-documents.controller';
import { EmployeeDocumentsService } from './documents/employee-documents.service';
import { EmployeeImportProcessor } from './import/employee-import.processor';
import { EmployeeImportService } from './import/employee-import.service';
import { EmployeeMapper } from './employee-mapper';
import { EmployeeService } from './employee.service';
import { EmployeesController } from './employees.controller';
import { OrgChartService } from './org-chart.service';

/**
 * The Employee module (step 1.1, Phase 1) — see docs/conventions/employee.md.
 * Imports `CustomFieldsModule` (not `@Global()`) to inject
 * `CustomFieldValueService` directly, exactly the reuse
 * `custom-field-value.service.ts`'s own doc comment invites for "a future
 * real entity module (Employee, ...)". `EncryptionService`/`StorageService`
 * need no explicit import — both `EncryptionModule`/`StorageModule` are
 * `@Global()`.
 *
 * `BullModule.registerQueue({name: EMPLOYEE_IMPORT_QUEUE})` is the SAME
 * reusable pattern `NotificationsModule` (0.8) established — see
 * `QueueModule`'s doc comment.
 */
@Module({
  imports: [
    CustomFieldsModule,
    BullModule.registerQueue({
      name: EMPLOYEE_IMPORT_QUEUE,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    }),
  ],
  controllers: [EmployeesController, EmployeeDocumentsController],
  providers: [
    EmployeeService,
    EmployeeMapper,
    OrgChartService,
    EmployeeDocumentsService,
    EmployeeImportService,
    EmployeeImportProcessor,
  ],
  exports: [EmployeeService],
})
export class EmployeesModule {}
