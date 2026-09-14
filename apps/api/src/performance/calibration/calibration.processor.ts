import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { ratingLevelSchema } from '@hrm/shared';
import { PERFORMANCE_CALIBRATION_QUEUE } from '../../queue/queue.constants';
import { shouldAutorunWorkers } from '../../queue/queue-worker.util';
import type { CalibrationRecomputeJobData } from './calibration-queue.service';
import { computeCalibrationRows } from './calibration-rollup.util';

/**
 * The rollup job's WORKER side — context-less (no `TenantContextService`),
 * the SAME posture every Phase 1 processor already takes. Computes ONE
 * cycle's full distribution in a single transaction: reads every
 * `COMPLETED` `Appraisal` for the cycle (joined to `Employee` for branch/
 * department), groups via the pure `computeCalibrationRows`, then DELETEs
 * the cycle's existing snapshot rows and bulk `createMany`s the fresh ones
 * — the SAME delete-then-recreate shape `AnalyticsRollupProcessor` already
 * uses, for the identical reason (nullable `departmentId` breaks
 * unique-key upsert matching — see analytics-dashboard.md).
 */
@Processor(PERFORMANCE_CALIBRATION_QUEUE, { autorun: shouldAutorunWorkers() })
export class CalibrationProcessor extends WorkerHost {
  async process(job: Job<CalibrationRecomputeJobData>): Promise<void> {
    const { tenantId, cycleId } = job.data;

    await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      const cycle = await tx.appraisalCycle.findUnique({ where: { id: cycleId }, include: { ratingScale: true } });
      if (!cycle) {
        return;
      }
      const levels = ratingLevelSchema.array().parse(cycle.ratingScale.levels);

      const appraisals = await tx.appraisal.findMany({
        where: { cycleId, status: 'COMPLETED', overallRating: { not: null } },
        select: { overallRating: true, employee: { select: { branchId: true, departmentId: true } } },
      });
      const rows = computeCalibrationRows(
        appraisals.map((appraisal) => ({
          overallRating: appraisal.overallRating!,
          branchId: appraisal.employee.branchId,
          departmentId: appraisal.employee.departmentId,
        })),
        levels,
      );

      await tx.appraisalRatingDistributionSnapshot.deleteMany({ where: { tenantId, cycleId } });
      if (rows.length > 0) {
        await tx.appraisalRatingDistributionSnapshot.createMany({
          data: rows.map((row) => ({ tenantId, cycleId, ...row })),
        });
      }
    });
  }
}
