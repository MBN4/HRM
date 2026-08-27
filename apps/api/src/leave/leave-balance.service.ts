import { BadRequestException, Injectable } from '@nestjs/common';
import type { LeaveBalance, LeaveType, Prisma } from '@hrm/db';
import { ACCRUED_LEAVE_TYPES } from './leave.constants';
import { entitlementForType } from './leave-entitlement.util';
import { resolveLeavePackConfig } from './leave-country-pack.util';

/** `accruedDays + carriedOverDays - usedDays` — never stored, always derived at read time. */
export function availableDays(balance: Pick<LeaveBalance, 'accruedDays' | 'carriedOverDays' | 'usedDays'>): number {
  return balance.accruedDays + balance.carriedOverDays - balance.usedDays;
}

/**
 * Owns the `LeaveBalance` row per (employee, leaveType, year) — see
 * docs/conventions/leave.md. Every method takes `tx`/`tenantId` explicitly,
 * the same posture `EmployeeService`/`resolveRequiredEmployeeFields` (1.1)
 * already established, since this is called from both an HTTP request and
 * the accrual worker.
 */
@Injectable()
export class LeaveBalanceService {
  /**
   * Creates the balance row on first touch, snapshotting `entitledDays`
   * from the resolved Country Pack (+ tenant override) for the employee's
   * branch at that moment — see the model's own doc comment in
   * schema.prisma for why this is a snapshot, not re-resolved on every
   * read. MATERNITY/PATERNITY (not in `ACCRUED_LEAVE_TYPES`) start with
   * their full entitlement immediately available — see
   * `leave.constants.ts` for why these two types are not monthly-accrued.
   */
  async getOrCreateBalance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    branchId: string,
    leaveType: LeaveType,
    periodYear: number,
  ): Promise<LeaveBalance> {
    const existing = await tx.leaveBalance.findUnique({
      where: { tenantId_employeeId_leaveType_periodYear: { tenantId, employeeId, leaveType, periodYear } },
    });
    if (existing) {
      return existing;
    }

    const pack = await resolveLeavePackConfig(tx, tenantId, branchId);
    const entitledDays = entitlementForType(pack.leaveDefaults, leaveType);
    const isAccrued = (ACCRUED_LEAVE_TYPES as readonly string[]).includes(leaveType);

    return tx.leaveBalance.create({
      data: {
        tenantId,
        employeeId,
        leaveType,
        periodYear,
        entitledDays,
        accruedDays: isAccrued ? 0 : entitledDays,
      },
    });
  }

  async deduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    leaveType: LeaveType,
    periodYear: number,
    days: number,
  ): Promise<LeaveBalance> {
    const balance = await tx.leaveBalance.findUniqueOrThrow({
      where: { tenantId_employeeId_leaveType_periodYear: { tenantId, employeeId, leaveType, periodYear } },
    });
    return tx.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: balance.usedDays + days } });
  }

  async restore(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    leaveType: LeaveType,
    periodYear: number,
    days: number,
  ): Promise<LeaveBalance> {
    const balance = await tx.leaveBalance.findUniqueOrThrow({
      where: { tenantId_employeeId_leaveType_periodYear: { tenantId, employeeId, leaveType, periodYear } },
    });
    return tx.leaveBalance.update({
      where: { id: balance.id },
      data: { usedDays: Math.max(0, balance.usedDays - days) },
    });
  }

  /** HR/manager manual adjustment (grant or deduct) — `leave.approve`-gated at the controller. */
  async adjust(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    branchId: string,
    leaveType: LeaveType,
    periodYear: number,
    deltaDays: number,
  ): Promise<LeaveBalance> {
    const balance = await this.getOrCreateBalance(tx, tenantId, employeeId, branchId, leaveType, periodYear);
    const nextAccrued = balance.accruedDays + deltaDays;
    if (nextAccrued < 0) {
      throw new BadRequestException('This adjustment would take accruedDays below zero.');
    }
    return tx.leaveBalance.update({ where: { id: balance.id }, data: { accruedDays: nextAccrued } });
  }

  async listForEmployee(tx: Prisma.TransactionClient, employeeId: string, periodYear: number): Promise<LeaveBalance[]> {
    return tx.leaveBalance.findMany({ where: { employeeId, periodYear }, orderBy: { leaveType: 'asc' } });
  }
}
