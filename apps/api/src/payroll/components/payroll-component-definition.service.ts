import { BadRequestException, Injectable } from '@nestjs/common';
import type { Expr, ExprVariable, CreatePayrollComponentInput } from '@hrm/shared';
import type { PayrollComponentDefinition } from '@hrm/db';
import { Prisma } from '@hrm/db';

/** `FORMULA` components may reference ONLY these — see the schema's own doc comment for why (gross/monthly/annual salary aren't known until every component has already been summed). */
const PRE_GROSS_VARIABLES: readonly ExprVariable[] = ['basicSalary', 'yearsOfService'];

/** Walks the closed `Expr` AST (the SAME shape 0.5's evaluator interprets — no new evaluator, just a static check over its already-validated tree) and throws if any `var` node names a variable outside `PRE_GROSS_VARIABLES`. */
export function assertFormulaUsesOnlyPreGrossVariables(expr: Expr): void {
  switch (expr.type) {
    case 'const':
      return;
    case 'var':
      if (!PRE_GROSS_VARIABLES.includes(expr.name)) {
        throw new BadRequestException(
          `A payroll component formula may only reference ${PRE_GROSS_VARIABLES.join('/')} — "${expr.name}" is not known until gross pay is already computed.`,
        );
      }
      return;
    case 'binary':
      assertFormulaUsesOnlyPreGrossVariables(expr.left);
      assertFormulaUsesOnlyPreGrossVariables(expr.right);
      return;
    case 'clamp':
      assertFormulaUsesOnlyPreGrossVariables(expr.value);
      if (expr.min) assertFormulaUsesOnlyPreGrossVariables(expr.min);
      if (expr.max) assertFormulaUsesOnlyPreGrossVariables(expr.max);
  }
}

/**
 * CRUD for salary-STRUCTURE line items (earnings/allowances/discretionary
 * deductions) — see docs/conventions/payroll.md. Deliberately has NOTHING
 * to do with mandatory tax/statutory deductions, which come straight from
 * the resolved CountryPack via `PayrollEngineService` — this service only
 * ever touches `PayrollComponentDefinition`.
 */
@Injectable()
export class PayrollComponentDefinitionService {
  async upsert(tx: Prisma.TransactionClient, tenantId: string, input: CreatePayrollComponentInput): Promise<PayrollComponentDefinition> {
    if (input.calcKind === 'FORMULA') {
      assertFormulaUsesOnlyPreGrossVariables(input.formula);
    }

    return tx.payrollComponentDefinition.upsert({
      where: { tenantId_countryCode_key: { tenantId, countryCode: input.countryCode, key: input.key } },
      update: {
        name: input.name,
        type: input.type,
        calcKind: input.calcKind,
        order: input.order,
        isActive: input.isActive,
        fixedAmount: input.calcKind === 'FIXED_AMOUNT' ? input.fixedAmount : null,
        percentageOfBase: input.calcKind === 'PERCENTAGE_OF_BASE' ? input.percentageOfBase : null,
        percentageRate: input.calcKind === 'PERCENTAGE_OF_BASE' ? input.percentageRate : null,
        formula: input.calcKind === 'FORMULA' ? (input.formula as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
      create: {
        tenantId,
        countryCode: input.countryCode,
        key: input.key,
        name: input.name,
        type: input.type,
        calcKind: input.calcKind,
        order: input.order,
        isActive: input.isActive,
        fixedAmount: input.calcKind === 'FIXED_AMOUNT' ? input.fixedAmount : null,
        percentageOfBase: input.calcKind === 'PERCENTAGE_OF_BASE' ? input.percentageOfBase : null,
        percentageRate: input.calcKind === 'PERCENTAGE_OF_BASE' ? input.percentageRate : null,
        formula: input.calcKind === 'FORMULA' ? (input.formula as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  }

  async listActive(tx: Prisma.TransactionClient, countryCode: string): Promise<PayrollComponentDefinition[]> {
    return tx.payrollComponentDefinition.findMany({
      where: { countryCode, isActive: true },
      orderBy: { order: 'asc' },
    });
  }

  async list(tx: Prisma.TransactionClient, countryCode?: string): Promise<PayrollComponentDefinition[]> {
    return tx.payrollComponentDefinition.findMany({
      where: countryCode ? { countryCode } : {},
      orderBy: [{ countryCode: 'asc' }, { order: 'asc' }],
    });
  }
}
