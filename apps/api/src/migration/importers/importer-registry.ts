import { Injectable } from '@nestjs/common';
import type { ImportEntityTypeKey } from '@hrm/shared';
import { AttendanceHistoryImporter } from './attendance-history.importer';
import { BranchImporter } from './branch.importer';
import { CostCenterImporter } from './cost-center.importer';
import { DepartmentImporter } from './department.importer';
import { DesignationImporter } from './designation.importer';
import type { EntityImporter } from './entity-importer.interface';
import { EmployeeImporter } from './employee.importer';
import { LeaveBalanceImporter } from './leave-balance.importer';
import { PayslipHistoryImporter } from './payslip-history.importer';

/** One place resolving `ImportEntityType` -> the importer that actually knows how to validate/write it — see docs/conventions/data-migration.md. */
@Injectable()
export class ImporterRegistry {
  private readonly byType: Record<ImportEntityTypeKey, EntityImporter>;

  constructor(
    branch: BranchImporter,
    department: DepartmentImporter,
    designation: DesignationImporter,
    costCenter: CostCenterImporter,
    employee: EmployeeImporter,
    leaveBalance: LeaveBalanceImporter,
    attendanceHistory: AttendanceHistoryImporter,
    payslipHistory: PayslipHistoryImporter,
  ) {
    this.byType = {
      BRANCH: branch,
      DEPARTMENT: department,
      DESIGNATION: designation,
      COST_CENTER: costCenter,
      EMPLOYEE: employee,
      LEAVE_BALANCE: leaveBalance,
      ATTENDANCE_HISTORY: attendanceHistory,
      PAYSLIP_HISTORY: payslipHistory,
    };
  }

  get(entityType: ImportEntityTypeKey): EntityImporter {
    return this.byType[entityType];
  }
}
