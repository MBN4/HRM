import { PERMISSIONS } from '@hrm/shared';
import { RequiresPermission } from '../common/permissions/requires-permission.decorator';

/**
 * Cost-reporting amounts are field-level gated behind `salary.view` — the
 * SAME existing mechanism `PayrollRunLineResponseDto`/
 * `EmployeeResponseDto.compensation` already use (see
 * docs/conventions/field-level-permissions.md); an individual employee's
 * OWN contribution history (`GET /benefits/my-benefits`) is returned as
 * plain (ungated) data instead — the same "your own data is never out of
 * scope" posture this codebase takes for every other self-service route.
 */
export class BenefitCostReportPlanLineDto {
  planId!: string;
  planName!: string;
  benefitType!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  employeeTotal!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  employerTotal!: string;

  constructor(partial: BenefitCostReportPlanLineDto) {
    Object.assign(this, partial);
  }
}

export class BenefitCostReportStatutoryLineDto {
  name!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  employeeTotal!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  employerTotal!: string;

  constructor(partial: BenefitCostReportStatutoryLineDto) {
    Object.assign(this, partial);
  }
}

export class BenefitCostReportResponseDto {
  periodYear!: number;
  periodMonth!: number;
  plans!: BenefitCostReportPlanLineDto[];
  statutory!: BenefitCostReportStatutoryLineDto[];

  constructor(partial: BenefitCostReportResponseDto) {
    Object.assign(this, partial);
  }
}
