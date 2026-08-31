import { PERMISSIONS } from '@hrm/shared';
import { RequiresPermission } from '../common/permissions/requires-permission.decorator';

/**
 * Amounts are field-level gated behind `salary.view` — the SAME existing
 * mechanism `EmployeeResponseDto.compensation` already uses (see
 * docs/conventions/field-level-permissions.md), no new pattern. Money is
 * serialized as a STRING (`Prisma.Decimal#toString()`), never a JS
 * `number` — see docs/conventions/payroll.md's money-representation note.
 */
export class PayrollRunLineResponseDto {
  id!: string;
  employeeId!: string;
  status!: string;
  computedVia!: string | null;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  grossPay!: string | null;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  netPay!: string | null;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  employerCost!: string | null;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  componentBreakdown!: unknown;

  errorMessage!: string | null;
  computedAt!: string | null;

  constructor(partial: PayrollRunLineResponseDto) {
    Object.assign(this, partial);
  }
}

export class PayrollRunResponseDto {
  id!: string;
  branchId!: string;
  periodYear!: number;
  periodMonth!: number;
  status!: string;
  payrollMode!: string;
  workflowInstanceId!: string | null;
  currencyCode!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  totalGross!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  totalNet!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  totalEmployerCost!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  totalGrossBase!: string | null;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  totalNetBase!: string | null;

  createdAt!: string;

  lines?: PayrollRunLineResponseDto[];

  constructor(partial: PayrollRunResponseDto) {
    Object.assign(this, partial);
  }
}
