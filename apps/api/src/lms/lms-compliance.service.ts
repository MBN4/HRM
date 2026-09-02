import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { determineComplianceBucket, resolveRequiredCourseIdsByEmployee } from './lms-compliance.util';

export interface ComplianceGapRow {
  employeeId: string;
  employeeName: string;
  courseId: string;
  courseTitle: string;
  bucket: 'EXPIRING' | 'EXPIRED' | 'MISSING';
  expiresAt: string | null;
}

export interface TrainingCalendarEntry {
  type: 'ENROLLMENT_DUE' | 'CERTIFICATION_EXPIRY';
  date: string;
  employeeId: string;
  employeeName: string;
  courseId: string;
  courseTitle: string;
}

/**
 * The BOUNDED, operational drill-down that answers "who, specifically, is
 * missing or expiring" — a live, indexed, branch-filtered read, never a
 * rollup (the dashboard KPI numbers ARE a rollup — see
 * `TrainingComplianceDailySnapshot` and `LmsRollupService`). The same
 * two-tier split every other admin list screen in this codebase already
 * takes (e.g. `GET /payroll/runs`) — see docs/conventions/lms.md.
 */
@Injectable()
export class LmsComplianceService {
  async listGaps(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    allowedBranchIds: string[] | null,
    filters: { courseId?: string },
  ): Promise<ComplianceGapRow[]> {
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      return [];
    }

    const [requiredTrainings, employees] = await Promise.all([
      tx.requiredTraining.findMany({
        where: { tenantId, isActive: true, courseId: filters.courseId, OR: [{ branchId: null }, { branchId }] },
      }),
      tx.employee.findMany({
        where: { tenantId, branchId, status: 'ACTIVE' },
        select: { id: true, branchId: true, userId: true, firstName: true, lastName: true },
      }),
    ]);
    if (requiredTrainings.length === 0 || employees.length === 0) {
      return [];
    }

    const userIds = employees.map((e) => e.userId).filter((id): id is string => !!id);
    const userRoles = await tx.userRole.findMany({ where: { tenantId, userId: { in: userIds } }, select: { userId: true, roleId: true } });
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
    const courses = await tx.course.findMany({ where: { tenantId, id: { in: courseIds } }, select: { id: true, title: true } });
    const courseById = new Map(courses.map((c) => [c.id, c]));

    const employeeIds = [...requiredCourseIdsByEmployee.keys()];
    const certifications = await tx.certification.findMany({
      where: { tenantId, employeeId: { in: employeeIds }, courseId: { in: courseIds }, status: { in: ['ACTIVE', 'EXPIRED'] } },
      orderBy: { issuedAt: 'desc' },
    });
    const latestCertByKey = new Map<string, { status: 'ACTIVE' | 'EXPIRED'; expiresAt: Date | null }>();
    for (const cert of certifications) {
      const key = `${cert.employeeId}:${cert.courseId}`;
      if (!latestCertByKey.has(key)) {
        latestCertByKey.set(key, { status: cert.status as 'ACTIVE' | 'EXPIRED', expiresAt: cert.expiresAt });
      }
    }

    const today = new Date();
    const rows: ComplianceGapRow[] = [];
    for (const [employeeId, requiredCourses] of requiredCourseIdsByEmployee) {
      const employee = employees.find((e) => e.id === employeeId)!;
      for (const courseId of requiredCourses) {
        const cert = latestCertByKey.get(`${employeeId}:${courseId}`);
        const bucket = determineComplianceBucket(cert, today);
        if (bucket === 'COMPLIANT') {
          continue;
        }
        const course = courseById.get(courseId);
        if (!course) {
          continue;
        }
        rows.push({
          employeeId,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          courseId,
          courseTitle: course.title,
          bucket,
          expiresAt: cert?.expiresAt?.toISOString() ?? null,
        });
      }
    }
    return rows;
  }

  async calendar(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: { from: Date; to: Date; branchId?: string },
  ): Promise<TrainingCalendarEntry[]> {
    if (filters.to < filters.from) {
      throw new BadRequestException('"to" must not be before "from".');
    }

    let employeeIdFilter: string | undefined;
    let branchWhere: Prisma.EnrollmentWhereInput['branchId'];
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { tenantId, userId: callerUserId }, select: { id: true } });
      if (!own) {
        return [];
      }
      employeeIdFilter = own.id;
    } else if (filters.branchId) {
      branchWhere = filters.branchId;
    } else if (allowedBranchIds) {
      branchWhere = { in: allowedBranchIds };
    }

    const [dueEnrollments, expiringCerts] = await Promise.all([
      tx.enrollment.findMany({
        where: {
          tenantId,
          employeeId: employeeIdFilter,
          branchId: employeeIdFilter ? undefined : branchWhere,
          dueDate: { gte: filters.from, lte: filters.to },
        },
        include: { employee: { select: { firstName: true, lastName: true } }, course: { select: { title: true } } },
      }),
      tx.certification.findMany({
        where: {
          tenantId,
          employeeId: employeeIdFilter,
          status: 'ACTIVE',
          expiresAt: { gte: filters.from, lte: filters.to },
        },
        include: { employee: { select: { firstName: true, lastName: true, branchId: true } }, course: { select: { title: true } } },
      }),
    ]);

    const entries: TrainingCalendarEntry[] = dueEnrollments.map((e) => ({
      type: 'ENROLLMENT_DUE',
      date: e.dueDate!.toISOString(),
      employeeId: e.employeeId,
      employeeName: `${e.employee.firstName} ${e.employee.lastName}`,
      courseId: e.courseId,
      courseTitle: e.course.title,
    }));

    for (const cert of expiringCerts) {
      if (canManageOthers && !employeeIdFilter) {
        const branchOk = filters.branchId
          ? cert.employee.branchId === filters.branchId
          : !allowedBranchIds || allowedBranchIds.includes(cert.employee.branchId);
        if (!branchOk) {
          continue;
        }
      }
      entries.push({
        type: 'CERTIFICATION_EXPIRY',
        date: cert.expiresAt!.toISOString(),
        employeeId: cert.employeeId,
        employeeName: `${cert.employee.firstName} ${cert.employee.lastName}`,
        courseId: cert.courseId,
        courseTitle: cert.course.title,
      });
    }

    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }
}
