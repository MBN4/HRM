import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { LMS_ROLLUP_QUEUE } from '../../queue/queue.constants';
import { determineComplianceBucket, resolveRequiredCourseIdsByEmployee } from '../lms-compliance.util';
import type { LmsRollupJobData } from './lms-rollup.service';
import { LmsRollupService } from './lms-rollup.service';
import { computeComplianceRows, computeCourseCompletionRows, toUtcDateOnly } from './lms-rollup.util';
import type { ComplianceEmployeeCoursePair } from './lms-rollup.util';

/**
 * The rollup job's WORKER side — see `LmsRollupService`'s doc comment and
 * docs/conventions/lms.md. Two job names share this one processor/queue,
 * mirroring `AnalyticsRollupProcessor` exactly: `orchestrate` (fans out,
 * computes nothing) and `rollup-tenant` (`{ tenantId, date }`, one
 * `withTenantContext` transaction, DELETE-then-`createMany` for both
 * tables — see analytics-dashboard.md for why delete+recreate rather than
 * upsert: nullable `departmentId` breaks unique-key upsert matching).
 */
@Processor(LMS_ROLLUP_QUEUE)
export class LmsRollupProcessor extends WorkerHost {
  constructor(private readonly rollupService: LmsRollupService) {
    super();
  }

  async process(job: Job<LmsRollupJobData | Record<string, never>>): Promise<void> {
    if (job.name === 'orchestrate') {
      await this.rollupService.enqueueForEveryLiveTenant();
      return;
    }

    const { tenantId, date } = job.data as LmsRollupJobData;
    const theDate = toUtcDateOnly(new Date(date));

    await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      await this.rollCompletion(tx, tenantId, theDate);
      await this.rollCompliance(tx, tenantId, theDate);
    });
  }

  private async rollCompletion(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<void> {
    const enrollments = await tx.enrollment.findMany({
      select: { branchId: true, courseId: true, status: true, employee: { select: { departmentId: true } } },
    });
    const rows = computeCourseCompletionRows(
      enrollments.map((e) => ({ branchId: e.branchId, departmentId: e.employee.departmentId, courseId: e.courseId, status: e.status })),
    );

    await tx.courseCompletionDailySnapshot.deleteMany({ where: { tenantId, snapshotDate: date } });
    if (rows.length > 0) {
      await tx.courseCompletionDailySnapshot.createMany({ data: rows.map((row) => ({ tenantId, snapshotDate: date, ...row })) });
    }
  }

  private async rollCompliance(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<void> {
    const requiredTrainings = await tx.requiredTraining.findMany({ where: { isActive: true } });
    if (requiredTrainings.length === 0) {
      await tx.trainingComplianceDailySnapshot.deleteMany({ where: { tenantId, snapshotDate: date } });
      return;
    }

    const employees = await tx.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, branchId: true, departmentId: true, userId: true },
    });
    const userIds = employees.map((e) => e.userId).filter((id): id is string => !!id);
    const userRoles = await tx.userRole.findMany({ where: { userId: { in: userIds } }, select: { userId: true, roleId: true } });
    const roleIdsByUserId = new Map<string, Set<string>>();
    for (const row of userRoles) {
      const set = roleIdsByUserId.get(row.userId) ?? new Set<string>();
      set.add(row.roleId);
      roleIdsByUserId.set(row.userId, set);
    }
    const employeeRoleIds = new Map<string, Set<string>>();
    for (const employee of employees) {
      employeeRoleIds.set(employee.id, employee.userId ? (roleIdsByUserId.get(employee.userId) ?? new Set()) : new Set());
    }

    const requiredCourseIdsByEmployee = resolveRequiredCourseIdsByEmployee(employees, requiredTrainings, employeeRoleIds);
    const courseIds = [...new Set(requiredTrainings.map((r) => r.courseId))];
    const employeeIds = [...requiredCourseIdsByEmployee.keys()];
    const certifications = await tx.certification.findMany({
      where: { employeeId: { in: employeeIds }, courseId: { in: courseIds }, status: { in: ['ACTIVE', 'EXPIRED'] } },
      orderBy: { issuedAt: 'desc' },
    });
    const latestCertByKey = new Map<string, { status: 'ACTIVE' | 'EXPIRED'; expiresAt: Date | null }>();
    for (const cert of certifications) {
      const key = `${cert.employeeId}:${cert.courseId}`;
      if (!latestCertByKey.has(key)) {
        latestCertByKey.set(key, { status: cert.status as 'ACTIVE' | 'EXPIRED', expiresAt: cert.expiresAt });
      }
    }

    const pairs: ComplianceEmployeeCoursePair[] = [];
    for (const [employeeId, courseIdSet] of requiredCourseIdsByEmployee) {
      const employee = employees.find((e) => e.id === employeeId)!;
      for (const courseId of courseIdSet) {
        const cert = latestCertByKey.get(`${employeeId}:${courseId}`);
        pairs.push({
          branchId: employee.branchId,
          departmentId: employee.departmentId,
          courseId,
          bucket: determineComplianceBucket(cert, date),
        });
      }
    }
    const rows = computeComplianceRows(pairs);

    await tx.trainingComplianceDailySnapshot.deleteMany({ where: { tenantId, snapshotDate: date } });
    if (rows.length > 0) {
      await tx.trainingComplianceDailySnapshot.createMany({ data: rows.map((row) => ({ tenantId, snapshotDate: date, ...row })) });
    }
  }
}
