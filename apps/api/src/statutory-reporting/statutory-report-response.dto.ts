import { PERMISSIONS } from '@hrm/shared';
import { RequiresPermission } from '../common/permissions/requires-permission.decorator';

/**
 * `summary` (employee count + aggregate wage/tax totals) is field-level
 * gated behind `salary.view` — the SAME existing mechanism
 * `PayrollRunResponseDto`/`BenefitCostReportPlanLineDto` already use (see
 * docs/conventions/field-level-permissions.md). In practice every role
 * that holds `statutory_report.read` also holds `salary.view` (both are
 * TENANT_ADMIN/HR_MANAGER-only — see permissions.ts), so this is
 * defense-in-depth for a custom role, not a change in who can see what
 * today.
 */
export class GeneratedReportResponseDto {
  id!: string;
  branchId!: string;
  reportDefinitionId!: string;
  reportCode!: string;
  countryCode!: string;
  periodType!: string;
  periodYear!: number;
  periodMonth!: number | null;
  periodQuarter!: number | null;
  periodKey!: string;
  status!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  summary!: unknown;

  errorMessage!: string | null;
  generatedAt!: string | null;
  createdAt!: string;

  constructor(partial: GeneratedReportResponseDto) {
    Object.assign(this, partial);
  }
}
