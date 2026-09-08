import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { BenefitPlan, BenefitPlanTier, Prisma } from '@hrm/db';
import { Prisma as PrismaNS } from '@hrm/db';
import type { CreateBenefitPlanInput } from '@hrm/shared';

/**
 * Tenant-configurable benefit plan definitions — see
 * docs/conventions/benefits.md. A plan's cost structure mirrors
 * `PayrollComponentDefinition` field-for-field (`FIXED_AMOUNT`/
 * `PERCENTAGE_OF_BASE`/`FORMULA`, `FORMULA` reusing 0.5's `Expr`/
 * `evaluateExpression` AS-IS); `employeeSharePercent`/`employerSharePercent`
 * then split ONE computed total cost, rather than two independently
 * configured amounts that could silently drift apart from each other.
 * `hasTiers` plans replace the whole tier set on every write — the SAME
 * "PUT replaces the whole resource" contract `EmployeeDependent`/
 * `TenantCountryOverride` already establish elsewhere in this codebase.
 */
@Injectable()
export class BenefitPlanService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreateBenefitPlanInput): Promise<BenefitPlan & { tiers: BenefitPlanTier[] }> {
    const data: Prisma.BenefitPlanUncheckedCreateInput = {
      tenantId,
      code: input.code,
      name: input.name,
      benefitType: input.benefitType,
      description: input.description ?? null,
      currencyCode: input.currencyCode,
      costBasis: input.costBasis,
      fixedAmount: input.costBasis === 'FIXED_AMOUNT' ? input.fixedAmount : null,
      percentageOfBase: input.costBasis === 'PERCENTAGE_OF_BASE' ? input.percentageOfBase : null,
      percentageRate: input.costBasis === 'PERCENTAGE_OF_BASE' ? input.percentageRate : null,
      formula: input.costBasis === 'FORMULA' ? (input.formula as Prisma.InputJsonValue) : PrismaNS.JsonNull,
      employeeSharePercent: input.employeeSharePercent,
      employerSharePercent: input.employerSharePercent,
      hasTiers: input.hasTiers,
      allowSelfElection: input.allowSelfElection,
      requiresApproval: input.requiresApproval,
      affectsPayroll: input.affectsPayroll,
      isActive: input.isActive,
    };

    const plan = await tx.benefitPlan.upsert({
      where: { tenantId_code: { tenantId, code: input.code } },
      update: data,
      create: data,
    });

    // Full replace — delete then recreate, the same shape
    // `EmployeeService`'s dependents/emergency-contacts full-replace
    // already takes for a small, tenant-owned child collection.
    await tx.benefitPlanTier.deleteMany({ where: { tenantId, planId: plan.id } });
    if (input.tiers.length > 0) {
      await tx.benefitPlanTier.createMany({
        data: input.tiers.map((tier) => ({
          tenantId,
          planId: plan.id,
          key: tier.key,
          label: tier.label,
          employeeAmount: tier.employeeAmount,
          employerAmount: tier.employerAmount,
          order: tier.order,
        })),
      });
    }

    const tiers = await tx.benefitPlanTier.findMany({ where: { tenantId, planId: plan.id }, orderBy: { order: 'asc' } });
    return { ...plan, tiers };
  }

  async list(tx: Prisma.TransactionClient, tenantId: string, filters: { isActive?: boolean; allowSelfElectionOnly?: boolean } = {}): Promise<(BenefitPlan & { tiers: BenefitPlanTier[] })[]> {
    const where: Prisma.BenefitPlanWhereInput = { tenantId };
    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    if (filters.allowSelfElectionOnly) {
      where.allowSelfElection = true;
    }
    return tx.benefitPlan.findMany({ where, include: { tiers: { orderBy: { order: 'asc' } } }, orderBy: { name: 'asc' } });
  }

  async findById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<BenefitPlan & { tiers: BenefitPlanTier[] }> {
    const plan = await tx.benefitPlan.findFirst({ where: { tenantId, id }, include: { tiers: { orderBy: { order: 'asc' } } } });
    if (!plan) {
      throw new NotFoundException(`Benefit plan "${id}" was not found.`);
    }
    return plan;
  }

  async requireActiveById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<BenefitPlan & { tiers: BenefitPlanTier[] }> {
    const plan = await this.findById(tx, tenantId, id);
    if (!plan.isActive) {
      throw new BadRequestException(`Benefit plan "${id}" is not active.`);
    }
    return plan;
  }
}
