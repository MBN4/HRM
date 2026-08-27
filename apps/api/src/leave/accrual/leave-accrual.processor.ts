import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Employee, LeaveType, Prisma } from '@hrm/db';
import { Prisma as PrismaNS, withTenantContext } from '@hrm/db';
import { IdempotencyService } from '../../resilience/idempotency/idempotency.service';
import { LEAVE_ACCRUAL_QUEUE } from '../../queue/queue.constants';
import { ACCRUED_LEAVE_TYPES } from '../leave.constants';
import { entitlementForType } from '../leave-entitlement.util';
import { resolveLeavePackConfig } from '../leave-country-pack.util';
import { LeaveBalanceService } from '../leave-balance.service';
import type { LeaveAccrualJobData } from './leave-accrual.service';
import { prorationFactorForJoinMonth } from './leave-proration.util';

const IDEMPOTENCY_SCOPE = 'leave-accrual';

/**
 * The scheduled-accrual job's WORKER side — see docs/conventions/leave.md
 * and `QueueModule`'s doc comment for the reusable BullMQ pattern this
 * instantiates. Runs entirely OUTSIDE any HTTP request — no
 * `TenantContextService` context exists here — so `tenantId` arrives as
 * explicit job data and every DB access opens its OWN `withTenantContext`
 * transaction, the SAME "context-less worker" posture
 * `EmployeeImportProcessor` (1.1) already established.
 *
 * IDEMPOTENT ON RE-RUN, on TWO independent layers (this project's "no
 * single layer trusted alone" posture): (1) `IdempotencyService` (0.10,
 * Redis-backed `execute()`, called directly rather than via the HTTP-only
 * `@Idempotent()` decorator — exactly the "call `execute` directly from a
 * service that isn't behind a route at all" usage that service's own doc
 * comment invites) claims `tenant:employee:leaveType:year-month` BEFORE
 * doing any work, so a re-run/retry that finds the key already `COMPLETED`
 * never re-executes the per-employee accrual at all; (2) the
 * `LeaveAccrualRun` row's own `@@unique([tenantId, employeeId, leaveType,
 * periodYear, periodMonth])` constraint is a DATABASE-layer backstop —
 * `P2002` on that `create()` is treated as "already accrued, no-op" rather
 * than an error.
 */
@Processor(LEAVE_ACCRUAL_QUEUE)
export class LeaveAccrualProcessor extends WorkerHost {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly balances: LeaveBalanceService,
  ) {
    super();
  }

  async process(job: Job<LeaveAccrualJobData>): Promise<void> {
    const { tenantId, periodYear, periodMonth } = job.data;

    const employees = await withTenantContext(tenantId, (tx: Prisma.TransactionClient) =>
      tx.employee.findMany({ where: { status: 'ACTIVE' } }),
    );

    for (const employee of employees) {
      for (const leaveType of ACCRUED_LEAVE_TYPES) {
        await this.accrueOne(tenantId, employee, leaveType as LeaveType, periodYear, periodMonth);
      }
    }
  }

  private async accrueOne(
    tenantId: string,
    employee: Employee,
    leaveType: LeaveType,
    periodYear: number,
    periodMonth: number,
  ): Promise<void> {
    const key = `${tenantId}:${employee.id}:${leaveType}:${periodYear}-${periodMonth}`;

    await this.idempotency.execute(IDEMPOTENCY_SCOPE, key, () =>
      withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
        const pack = await resolveLeavePackConfig(tx, tenantId, employee.branchId);
        const entitledDays = entitlementForType(pack.leaveDefaults, leaveType);
        if (entitledDays <= 0) {
          return;
        }

        const proratedFactor = prorationFactorForJoinMonth(employee.joinDate, periodYear, periodMonth);
        if (proratedFactor === null) {
          return;
        }

        const accruedAmount = (entitledDays / 12) * proratedFactor;

        try {
          await tx.leaveAccrualRun.create({
            data: { tenantId, employeeId: employee.id, leaveType, periodYear, periodMonth, accruedAmount, proratedFactor },
          });
        } catch (error) {
          if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
            return;
          }
          throw error;
        }

        const balance = await this.balances.getOrCreateBalance(
          tx,
          tenantId,
          employee.id,
          employee.branchId,
          leaveType,
          periodYear,
        );
        const nextAccrued = Math.min(balance.entitledDays, balance.accruedDays + accruedAmount);
        await tx.leaveBalance.update({ where: { id: balance.id }, data: { accruedDays: nextAccrued } });
      }),
    );
  }
}
