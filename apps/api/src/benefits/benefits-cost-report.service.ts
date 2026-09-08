import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { Prisma as PrismaNS } from '@hrm/db';

export interface BenefitCostReportPlanLine {
  planId: string;
  planName: string;
  benefitType: string;
  employeeTotal: string;
  employerTotal: string;
}

export interface BenefitCostReportStatutoryLine {
  name: string;
  employeeTotal: string;
  employerTotal: string;
}

export interface BenefitCostReport {
  periodYear: number;
  periodMonth: number;
  plans: BenefitCostReportPlanLine[];
  statutory: BenefitCostReportStatutoryLine[];
}

/**
 * Employee-vs-employer cost reporting — see docs/conventions/benefits.md.
 * Reads already-computed data ONLY, never recomputes anything: plan-based
 * totals come straight from `BenefitContributionRecord` (written once by
 * `PayrollRunProcessor`'s `mergeBenefitContributions` step); statutory
 * totals are read back out of the SAME `PayrollRunLine.componentBreakdown`
 * the unmodified engine already produces, filtered to exclude this
 * module's own `benefit_*`-keyed lines (which would otherwise double-count
 * the employer-share plan totals above — both are tagged `EMPLOYER_COST`
 * on the breakdown). Scoped to ONE period + one bounded employee set (a
 * branch or the caller's allowed branches) per call — a live aggregate,
 * not a precomputed rollup, since (unlike 1.5's tenant-wide, continuously-
 * queried dashboard) this query's cost is bounded by one branch's
 * headcount for one period, the SAME "no rollup needed yet" scope call
 * `operations-modules.md`'s cost surfaces already make for themselves.
 */
@Injectable()
export class BenefitsCostReportService {
  async generate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    params: { periodYear: number; periodMonth: number; branchId?: string; allowedBranchIds: string[] | null },
  ): Promise<BenefitCostReport> {
    const employeeWhere: Prisma.EmployeeWhereInput = { tenantId };
    if (params.branchId) {
      employeeWhere.branchId = params.branchId;
    } else if (params.allowedBranchIds) {
      employeeWhere.branchId = { in: params.allowedBranchIds };
    }
    const employeeIds = (await tx.employee.findMany({ where: employeeWhere, select: { id: true } })).map((e) => e.id);
    if (employeeIds.length === 0) {
      return { periodYear: params.periodYear, periodMonth: params.periodMonth, plans: [], statutory: [] };
    }

    const contributionRecords = await tx.benefitContributionRecord.findMany({
      where: { tenantId, periodYear: params.periodYear, periodMonth: params.periodMonth, employeeId: { in: employeeIds } },
    });
    const planTotals = new Map<string, { employeeTotal: Prisma.Decimal; employerTotal: Prisma.Decimal }>();
    for (const record of contributionRecords) {
      const existing = planTotals.get(record.planId) ?? { employeeTotal: new PrismaNS.Decimal(0), employerTotal: new PrismaNS.Decimal(0) };
      existing.employeeTotal = existing.employeeTotal.add(record.employeeAmount);
      existing.employerTotal = existing.employerTotal.add(record.employerAmount);
      planTotals.set(record.planId, existing);
    }
    const plans = await tx.benefitPlan.findMany({ where: { tenantId, id: { in: [...planTotals.keys()] } } });
    const planLines: BenefitCostReportPlanLine[] = plans.map((plan) => {
      const totals = planTotals.get(plan.id)!;
      return { planId: plan.id, planName: plan.name, benefitType: plan.benefitType, employeeTotal: totals.employeeTotal.toString(), employerTotal: totals.employerTotal.toString() };
    });

    const runLines = await tx.payrollRunLine.findMany({
      where: { tenantId, employeeId: { in: employeeIds }, status: 'COMPUTED', payrollRun: { periodYear: params.periodYear, periodMonth: params.periodMonth } },
    });
    const statutoryTotals = new Map<string, { employeeTotal: Prisma.Decimal; employerTotal: Prisma.Decimal }>();
    for (const line of runLines) {
      const breakdown = Array.isArray(line.componentBreakdown) ? (line.componentBreakdown as { key: string; type: string; amount: number }[]) : [];
      for (const item of breakdown) {
        if (item.key.startsWith('benefit_') || (item.type !== 'EMPLOYEE_STATUTORY' && item.type !== 'EMPLOYER_COST')) {
          continue;
        }
        const existing = statutoryTotals.get(item.key) ?? { employeeTotal: new PrismaNS.Decimal(0), employerTotal: new PrismaNS.Decimal(0) };
        if (item.type === 'EMPLOYEE_STATUTORY') {
          existing.employeeTotal = existing.employeeTotal.add(item.amount);
        } else {
          existing.employerTotal = existing.employerTotal.add(item.amount);
        }
        statutoryTotals.set(item.key, existing);
      }
    }
    const statutory: BenefitCostReportStatutoryLine[] = [...statutoryTotals.entries()].map(([name, totals]) => ({
      name,
      employeeTotal: totals.employeeTotal.toString(),
      employerTotal: totals.employerTotal.toString(),
    }));

    return { periodYear: params.periodYear, periodMonth: params.periodMonth, plans: planLines, statutory };
  }
}
