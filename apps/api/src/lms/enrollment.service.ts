import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ContentProgress, Employee, Enrollment, Prisma } from '@hrm/db';
import { AssignEnrollmentInput } from '@hrm/shared';
import { CertificationService } from './certification.service';

export type EnrollmentWithProgress = Enrollment & { progress: ContentProgress[] };

/**
 * Enrollment + progress + completion — see docs/conventions/lms.md.
 * `enroll` is self-service only (`lms.enroll`); `assign` is the admin/
 * manager path (`lms.assign`), the SAME "who is this FOR" split
 * `ExpenseClaimService.resolveTargetEmployee` already establishes,
 * expressed here as two distinct routes/methods instead of one optional
 * `employeeId` field, since assignment also needs its OWN fields
 * (`dueDate`) and its own notification.
 *
 * A course COMPLETES once every content item is COMPLETED and — if the
 * course declares a required quiz — the employee holds a passing
 * `QuizAttempt`; `recomputeCompletion` is the ONE place this is decided,
 * called after every content-progress mark AND every quiz submission (see
 * QuizService) so completion can never be computed two different ways.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly certifications: CertificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async enroll(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, courseId: string): Promise<Enrollment> {
    const employee = await this.requireOwnEmployee(tx, callerUserId);
    const course = await this.requirePublishedCourse(tx, tenantId, courseId);
    await this.assertNoActiveEnrollment(tx, tenantId, courseId, employee.id);

    return tx.enrollment.create({
      data: { tenantId, courseId: course.id, employeeId: employee.id, branchId: employee.branchId, source: 'SELF' },
    });
  }

  async assign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    courseId: string,
    input: AssignEnrollmentInput,
  ): Promise<Enrollment> {
    const course = await this.requirePublishedCourse(tx, tenantId, courseId);
    const employee = await tx.employee.findFirst({ where: { tenantId, id: input.employeeId } });
    if (!employee) {
      throw new NotFoundException(`Employee "${input.employeeId}" was not found.`);
    }
    await this.assertNoActiveEnrollment(tx, tenantId, courseId, employee.id);

    const enrollment = await tx.enrollment.create({
      data: {
        tenantId,
        courseId: course.id,
        employeeId: employee.id,
        branchId: employee.branchId,
        source: 'ASSIGNED',
        enrolledByUserId: callerUserId,
        dueDate: input.dueDate ?? null,
      },
    });

    if (employee.userId) {
      this.eventEmitter.emit('lms.course_assigned', {
        type: 'lms.course_assigned',
        tenantId,
        enrollmentId: enrollment.id,
        courseId: course.id,
        assigneeUserId: employee.userId,
      });
    }

    return enrollment;
  }

  async markContentComplete(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    enrollmentId: string,
    contentItemId: string,
  ): Promise<ContentProgress> {
    const enrollment = await this.requireOwnedEnrollment(tx, tenantId, callerUserId, canManageOthers, enrollmentId);
    const item = await tx.courseContentItem.findFirst({ where: { tenantId, id: contentItemId, courseId: enrollment.courseId } });
    if (!item) {
      throw new NotFoundException(`Content item "${contentItemId}" was not found on this enrollment's course.`);
    }

    const progress = await tx.contentProgress.upsert({
      where: { tenantId_enrollmentId_contentItemId: { tenantId, enrollmentId, contentItemId } },
      update: { status: 'COMPLETED', completedAt: new Date() },
      create: { tenantId, enrollmentId, contentItemId, status: 'COMPLETED', completedAt: new Date() },
    });

    await tx.enrollment.update({
      where: { id: enrollment.id },
      data: { status: 'IN_PROGRESS', startedAt: enrollment.startedAt ?? new Date() },
    });
    await this.recomputeCompletion(tx, tenantId, enrollment.id);
    return progress;
  }

  /**
   * The one place course completion is decided — called after every
   * content-progress mark (above) and every quiz attempt submission (see
   * QuizService.submitAttempt). Idempotent: re-running against an
   * already-COMPLETED enrollment is a no-op (issuing a SECOND certification
   * for the same completion would be wrong).
   */
  async recomputeCompletion(tx: Prisma.TransactionClient, tenantId: string, enrollmentId: string): Promise<void> {
    const enrollment = await tx.enrollment.findFirst({ where: { tenantId, id: enrollmentId } });
    if (!enrollment || enrollment.status === 'COMPLETED') {
      return;
    }

    const [contentCount, completedCount, quiz] = await Promise.all([
      tx.courseContentItem.count({ where: { tenantId, courseId: enrollment.courseId } }),
      tx.contentProgress.count({ where: { tenantId, enrollmentId, status: 'COMPLETED' } }),
      tx.quiz.findUnique({ where: { tenantId_courseId: { tenantId, courseId: enrollment.courseId } } }),
    ]);

    if (completedCount < contentCount) {
      return;
    }

    if (quiz?.isRequired) {
      const passedAttempt = await tx.quizAttempt.findFirst({
        where: { tenantId, quizId: quiz.id, enrollmentId, passed: true },
      });
      if (!passedAttempt) {
        return;
      }
    }

    const course = await tx.course.findUniqueOrThrow({ where: { id: enrollment.courseId } });
    const completed = await tx.enrollment.update({
      where: { id: enrollment.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await this.certifications.issueForCompletedEnrollment(tx, tenantId, course, completed.employeeId, completed.id);
  }

  async listMine(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string): Promise<EnrollmentWithProgress[]> {
    const employee = await this.requireOwnEmployee(tx, callerUserId);
    return tx.enrollment.findMany({
      where: { tenantId, employeeId: employee.id },
      include: { progress: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: { employeeId?: string; courseId?: string; status?: string; branchId?: string },
  ): Promise<Enrollment[]> {
    const where: Prisma.EnrollmentWhereInput = { tenantId };
    if (!canManageOthers) {
      where.enrolledByUserId = callerUserId;
    }
    if (filters.employeeId) {
      where.employeeId = filters.employeeId;
    }
    if (filters.courseId) {
      where.courseId = filters.courseId;
    }
    if (filters.status) {
      where.status = filters.status as Enrollment['status'];
    }
    if (filters.branchId) {
      where.branchId = filters.branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }
    return tx.enrollment.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    id: string,
  ): Promise<EnrollmentWithProgress> {
    return this.requireOwnedEnrollment(tx, tenantId, callerUserId, canManageOthers, id);
  }

  private async assertNoActiveEnrollment(tx: Prisma.TransactionClient, tenantId: string, courseId: string, employeeId: string): Promise<void> {
    const active = await tx.enrollment.findFirst({
      where: { tenantId, courseId, employeeId, status: { in: ['ENROLLED', 'IN_PROGRESS'] } },
    });
    if (active) {
      throw new ConflictException('This employee already has an active enrollment in this course.');
    }
  }

  private async requirePublishedCourse(tx: Prisma.TransactionClient, tenantId: string, courseId: string) {
    const course = await tx.course.findFirst({ where: { tenantId, id: courseId } });
    if (!course) {
      throw new NotFoundException(`Course "${courseId}" was not found.`);
    }
    if (course.status !== 'PUBLISHED') {
      throw new ConflictException(`Course "${courseId}" is not published.`);
    }
    return course;
  }

  private async requireOwnEmployee(tx: Prisma.TransactionClient, callerUserId: string): Promise<Employee> {
    const employee = await tx.employee.findFirst({ where: { userId: callerUserId } });
    if (!employee) {
      throw new NotFoundException('You have no employee profile.');
    }
    return employee;
  }

  private async requireOwnedEnrollment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    canManageOthers: boolean,
    id: string,
  ): Promise<EnrollmentWithProgress> {
    const enrollment = await tx.enrollment.findFirst({ where: { tenantId, id }, include: { progress: true } });
    if (!enrollment) {
      throw new NotFoundException(`Enrollment "${id}" was not found.`);
    }
    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own || own.id !== enrollment.employeeId) {
        throw new ForbiddenException('You may only act on your own enrollment.');
      }
    }
    return enrollment;
  }
}
