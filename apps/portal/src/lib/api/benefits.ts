import { apiFetch } from './client';
import type { BenefitCostReport, BenefitEnrollment, BenefitPlan, BenefitStatutoryPreview, BenefitType } from './types';

interface BenefitPlanTierInput {
  key: string;
  label: string;
  employeeAmount: number;
  employerAmount: number;
  order?: number;
}

interface BenefitPlanBaseInput {
  code: string;
  name: string;
  benefitType: BenefitType;
  description?: string;
  currencyCode: string;
  employeeSharePercent: number;
  employerSharePercent: number;
  hasTiers?: boolean;
  tiers?: BenefitPlanTierInput[];
  allowSelfElection?: boolean;
  requiresApproval?: boolean;
  affectsPayroll?: boolean;
  isActive?: boolean;
}

/**
 * `FORMULA` plans (reusing 0.5's closed `Expr` AST) are deliberately NOT
 * authorable through this admin form — the SAME documented gap
 * `payroll.ts`'s own `UpsertPayrollComponentInput` already carries (no
 * page in this app builds a JSON-expression editor); a `FORMULA` plan is
 * created via the API directly and simply RENDERS correctly here once it
 * exists.
 */
export type UpsertBenefitPlanInput =
  | (BenefitPlanBaseInput & { costBasis: 'FIXED_AMOUNT'; fixedAmount: number })
  | (BenefitPlanBaseInput & { costBasis: 'PERCENTAGE_OF_BASE'; percentageOfBase: 'basicSalary' | 'grossSalary' | 'monthlySalary' | 'annualSalary'; percentageRate: number });

export function upsertBenefitPlan(input: UpsertBenefitPlanInput): Promise<BenefitPlan> {
  return apiFetch<BenefitPlan>('/benefits/plans', { method: 'POST', body: input });
}

export function listBenefitPlans(params: { isActive?: boolean } = {}): Promise<BenefitPlan[]> {
  return apiFetch<BenefitPlan[]>('/benefits/plans', { query: params });
}

export function getBenefitPlan(id: string): Promise<BenefitPlan> {
  return apiFetch<BenefitPlan>(`/benefits/plans/${id}`);
}

export function getBenefitStatutory(branchId: string): Promise<BenefitStatutoryPreview> {
  return apiFetch<BenefitStatutoryPreview>('/benefits/statutory', { query: { branchId } });
}

export interface EnrollBenefitInput {
  employeeId?: string;
  planId: string;
  coverageTierId?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  dependentIds?: string[];
}

export function enrollInBenefit(input: EnrollBenefitInput): Promise<BenefitEnrollment> {
  return apiFetch<BenefitEnrollment>('/benefits/enrollments', { method: 'POST', body: input });
}

export function cancelBenefitEnrollment(id: string): Promise<BenefitEnrollment> {
  return apiFetch<BenefitEnrollment>(`/benefits/enrollments/${id}/cancel`, { method: 'POST' });
}

export function listBenefitEnrollments(params: { employeeId?: string; planId?: string; status?: string } = {}): Promise<BenefitEnrollment[]> {
  return apiFetch<BenefitEnrollment[]>('/benefits/enrollments', { query: params });
}

export function getBenefitEnrollment(id: string): Promise<BenefitEnrollment> {
  return apiFetch<BenefitEnrollment>(`/benefits/enrollments/${id}`);
}

export function listMyBenefits(): Promise<BenefitEnrollment[]> {
  return apiFetch<BenefitEnrollment[]>('/benefits/my-benefits');
}

export function getBenefitCostReport(params: { periodYear: number; periodMonth: number; branchId?: string }): Promise<BenefitCostReport> {
  return apiFetch<BenefitCostReport>('/benefits/cost-report', { query: params });
}
