import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Employee, ExpenseClaim, ExpenseLine, Prisma } from '@hrm/db';
import { Prisma as PrismaNS } from '@hrm/db';
import { ExpenseLineInput } from '@hrm/shared';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { ExchangeRateService } from '../payroll/runs/exchange-rate.service';
import { resolvePayrollPackConfig } from '../payroll/payroll-pack.util';
import { ExpenseCategoryService } from './expense-category.service';
import { EXPENSE_CLAIM_ENTITY_TYPE } from './expenses.constants';

/**
 * Expense claim lifecycle — see docs/conventions/operations-modules.md.
 * DRAFT (line items added one at a time) -> `submit` (policy-limit
 * enforcement + the REAL 0.7 workflow, `entityType: "EXPENSE_CLAIM"`) ->
 * APPROVED/REJECTED (via `ExpenseWorkflowEventsListener`, THE RULE — this
 * service owns NO approve/reject logic of its own) -> REIMBURSED (via
 * Payroll's own `PayrollRunProcessor`, never computed here).
 */
@Injectable()
export class ExpenseClaimService {
  constructor(
    private readonly categories: ExpenseCategoryService,
    private readonly workflowEngine: WorkflowEngineService,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  async createDraft(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    employeeId?: string,
  ): Promise<ExpenseClaim> {
    const employee = await this.resolveTargetEmployee(tx, callerUserId, canManageOthers, allowedBranchIds, employeeId);
    const pack = await resolvePayrollPackConfig(tx, tenantId, employee.branchId);
    return tx.expenseClaim.create({
      data: {
        tenantId,
        employeeId: employee.id,
        branchId: employee.branchId,
        currencyCode: pack.config.locale.currencyCode,
        status: 'DRAFT',
      },
    });
  }

  async addLine(
    tx: Prisma.TransactionClient,
    tenantId: string,
    claimId: string,
    callerUserId: string,
    canManageOthers: boolean,
    input: ExpenseLineInput,
  ): Promise<ExpenseLine> {
    const claim = await this.requireOwnedDraft(tx, tenantId, claimId, callerUserId, canManageOthers);
    const category = await this.categories.requireById(tx, tenantId, input.categoryId);

    const line = await tx.expenseLine.create({
      data: {
        tenantId,
        expenseClaimId: claim.id,
        categoryId: category.id,
        description: input.description,
        amount: input.amount,
        expenseDate: input.expenseDate,
      },
    });
    await this.recalculateTotal(tx, tenantId, claim.id);
    return line;
  }

  async attachReceipt(
    tx: Prisma.TransactionClient,
    tenantId: string,
    claimId: string,
    lineId: string,
    callerUserId: string,
    canManageOthers: boolean,
    receiptStorageKey: string,
  ): Promise<ExpenseLine> {
    await this.requireOwnedDraft(tx, tenantId, claimId, callerUserId, canManageOthers);
    const line = await tx.expenseLine.findFirst({ where: { tenantId, id: lineId, expenseClaimId: claimId } });
    if (!line) {
      throw new NotFoundException(`Expense line "${lineId}" was not found on claim "${claimId}".`);
    }
    return tx.expenseLine.update({ where: { id: line.id }, data: { receiptStorageKey } });
  }

  async requireLine(tx: Prisma.TransactionClient, tenantId: string, claimId: string, lineId: string): Promise<ExpenseLine> {
    const line = await tx.expenseLine.findFirst({ where: { tenantId, id: lineId, expenseClaimId: claimId } });
    if (!line) {
      throw new NotFoundException(`Expense line "${lineId}" was not found on claim "${claimId}".`);
    }
    return line;
  }

  async removeLine(
    tx: Prisma.TransactionClient,
    tenantId: string,
    claimId: string,
    lineId: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<void> {
    const claim = await this.requireOwnedDraft(tx, tenantId, claimId, callerUserId, canManageOthers);
    const line = await tx.expenseLine.findFirst({ where: { tenantId, id: lineId, expenseClaimId: claimId } });
    if (!line) {
      throw new NotFoundException(`Expense line "${lineId}" was not found on claim "${claimId}".`);
    }
    await tx.expenseLine.delete({ where: { id: line.id } });
    await this.recalculateTotal(tx, tenantId, claim.id);
  }

  /**
   * Policy limits are enforced HERE, at submission — never at line-add
   * time, so a claim can be drafted freely and corrected before it's
   * locked in. Every line's amount is checked against its OWN category's
   * `policyLimitAmount` (tenant-configurable DATA, `null` = unlimited) —
   * a 400 names exactly which line/category exceeded it, the same
   * "no meaningless combination silently accepted" posture this codebase
   * takes everywhere policy limits/required fields are enforced.
   */
  async submit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    claimId: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<ExpenseClaim> {
    const claim = await this.requireOwnedDraft(tx, tenantId, claimId, callerUserId, canManageOthers);
    const lines = await tx.expenseLine.findMany({ where: { tenantId, expenseClaimId: claim.id }, include: { category: true } });
    if (lines.length === 0) {
      throw new BadRequestException('An expense claim needs at least one line item before it can be submitted.');
    }
    for (const line of lines) {
      if (line.category.policyLimitAmount && line.amount.greaterThan(line.category.policyLimitAmount)) {
        throw new BadRequestException(
          `Line "${line.description}" (${line.amount.toString()} ${claim.currencyCode}) exceeds the "${line.category.name}" policy limit of ${line.category.policyLimitAmount.toString()} ${claim.currencyCode}.`,
        );
      }
    }

    const employee = await tx.employee.findUniqueOrThrow({ where: { id: claim.employeeId } });
    if (!employee.userId) {
      throw new BadRequestException(
        'This employee has no linked user account and cannot submit an expense claim (the workflow engine resolves approvers relative to a real requester user).',
      );
    }

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { baseCurrencyCode: true } });
    const rate = await this.exchangeRates.getRate(tx, claim.currencyCode, tenant.baseCurrencyCode, new Date());
    const totalAmountBaseCurrency = claim.totalAmount.mul(rate).toDecimalPlaces(2);

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: employee.userId,
      entityType: EXPENSE_CLAIM_ENTITY_TYPE,
      entityId: claim.id,
      dataSnapshot: {
        employeeId: employee.id,
        branchId: employee.branchId,
        amount: claim.totalAmount.toNumber(),
        currencyCode: claim.currencyCode,
      },
    });

    return tx.expenseClaim.update({
      where: { id: claim.id },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        workflowInstanceId: instance.id,
        exchangeRateToBase: rate,
        totalAmountBaseCurrency,
      },
    });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: { employeeId?: string; status?: string },
  ): Promise<(ExpenseClaim & { lines: ExpenseLine[] })[]> {
    const where: Prisma.ExpenseClaimWhereInput = { tenantId };
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      where.employeeId = own?.id ?? '__none__';
    } else if (filters.employeeId) {
      where.employeeId = filters.employeeId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }
    if (filters.status) {
      where.status = filters.status as ExpenseClaim['status'];
    }
    return tx.expenseClaim.findMany({ where, orderBy: { createdAt: 'desc' }, include: { lines: true } });
  }

  async findById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
  ): Promise<ExpenseClaim & { lines: ExpenseLine[] }> {
    const claim = await tx.expenseClaim.findFirst({ where: { tenantId, id }, include: { lines: true } });
    if (!claim) {
      throw new NotFoundException(`Expense claim "${id}" was not found.`);
    }
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own || own.id !== claim.employeeId) {
        throw new NotFoundException(`Expense claim "${id}" was not found.`);
      }
    } else if (allowedBranchIds && !allowedBranchIds.includes(claim.branchId)) {
      throw new NotFoundException(`Expense claim "${id}" was not found.`);
    }
    return claim;
  }

  private async recalculateTotal(tx: Prisma.TransactionClient, tenantId: string, claimId: string): Promise<void> {
    const lines = await tx.expenseLine.findMany({ where: { tenantId, expenseClaimId: claimId } });
    const total = lines.reduce((sum, line) => sum.add(line.amount), new PrismaNS.Decimal(0));
    await tx.expenseClaim.update({ where: { id: claimId }, data: { totalAmount: total } });
  }

  private async requireOwnedDraft(
    tx: Prisma.TransactionClient,
    tenantId: string,
    claimId: string,
    callerUserId: string,
    canManageOthers: boolean,
  ): Promise<ExpenseClaim> {
    const claim = await tx.expenseClaim.findFirst({ where: { tenantId, id: claimId } });
    if (!claim) {
      throw new NotFoundException(`Expense claim "${claimId}" was not found.`);
    }
    if (claim.status !== 'DRAFT') {
      throw new ConflictException(`Expense claim "${claimId}" is "${claim.status}" and can no longer be edited.`);
    }
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own || own.id !== claim.employeeId) {
        throw new ForbiddenException('You may only edit your own expense claim.');
      }
    }
    return claim;
  }

  private async resolveTargetEmployee(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    explicitEmployeeId?: string,
  ): Promise<Employee> {
    if (!explicitEmployeeId) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId } });
      if (!own) {
        throw new NotFoundException('You have no employee profile.');
      }
      return own;
    }

    const employee = await tx.employee.findUnique({ where: { id: explicitEmployeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
    }
    if (employee.userId !== callerUserId) {
      if (!canManageOthers) {
        throw new ForbiddenException('expense.manage is required to raise a claim on another employee\'s behalf.');
      }
      if (allowedBranchIds && !allowedBranchIds.includes(employee.branchId)) {
        throw new NotFoundException(`Employee "${explicitEmployeeId}" was not found.`);
      }
    }
    return employee;
  }
}
