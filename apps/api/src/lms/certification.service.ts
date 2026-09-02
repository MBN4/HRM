import { Injectable } from '@nestjs/common';
import type { Certification, Course, Prisma } from '@hrm/db';

/**
 * Certification issuance + renewal — see docs/conventions/lms.md.
 * RENEWAL means "retake the course": `issueForCompletedEnrollment` is
 * called by `EnrollmentService.recomputeCompletion` every time an
 * enrollment reaches COMPLETED. If an ACTIVE certification for the SAME
 * course+employee already exists, it is superseded (flipped to RENEWED,
 * linked via `renewedFromCertificationId`) rather than a second
 * implementation of "what renewal means" — never a separate manual
 * "renew without retaking" code path.
 */
@Injectable()
export class CertificationService {
  async issueForCompletedEnrollment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    course: Course,
    employeeId: string,
    enrollmentId: string,
  ): Promise<Certification> {
    const existingActive = await tx.certification.findFirst({
      where: { tenantId, courseId: course.id, employeeId, status: 'ACTIVE' },
      orderBy: { issuedAt: 'desc' },
    });

    const issuedAt = new Date();
    const expiresAt = course.validityMonths ? addMonths(issuedAt, course.validityMonths) : null;

    const created = await tx.certification.create({
      data: {
        tenantId,
        courseId: course.id,
        employeeId,
        enrollmentId,
        issuedAt,
        expiresAt,
        renewedFromCertificationId: existingActive?.id ?? null,
      },
    });

    if (existingActive) {
      await tx.certification.update({ where: { id: existingActive.id }, data: { status: 'RENEWED' } });
    }

    return created;
  }

  async listForEmployee(tx: Prisma.TransactionClient, tenantId: string, employeeId: string): Promise<Certification[]> {
    return tx.certification.findMany({ where: { tenantId, employeeId }, orderBy: { issuedAt: 'desc' } });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    filters: { employeeId?: string; courseId?: string; status?: string },
  ): Promise<Certification[]> {
    const where: Prisma.CertificationWhereInput = { tenantId };
    if (filters.employeeId) {
      where.employeeId = filters.employeeId;
    }
    if (filters.courseId) {
      where.courseId = filters.courseId;
    }
    if (filters.status) {
      where.status = filters.status as Certification['status'];
    }
    return tx.certification.findMany({ where, orderBy: { issuedAt: 'desc' } });
  }
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}
