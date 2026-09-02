import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { QuizAttempt, QuizQuestion } from '@hrm/db';
import {
  AssignEnrollmentInput,
  assignEnrollmentSchema,
  AUDIT_ACTIONS,
  CreateContentItemInput,
  createContentItemSchema,
  CreateCourseCategoryInput,
  createCourseCategorySchema,
  CreateCourseInput,
  createCourseSchema,
  CreateQuizQuestionInput,
  createQuizQuestionSchema,
  PERMISSIONS,
  RunLmsRollupInput,
  runLmsRollupSchema,
  SubmitQuizAttemptInput,
  submitQuizAttemptSchema,
  UpdateCourseInput,
  updateCourseSchema,
  UpsertQuizInput,
  upsertQuizSchema,
  UpsertRequiredTrainingInput,
  upsertRequiredTrainingSchema,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { StorageService } from '../storage/storage.service';
import { CourseCategoryService } from './course-category.service';
import { CourseService } from './course.service';
import { EnrollmentService } from './enrollment.service';
import { QuizService } from './quiz.service';
import { CertificationService } from './certification.service';
import { RequiredTrainingService } from './required-training.service';
import { LmsComplianceService } from './lms-compliance.service';
import { LmsAnalyticsService } from './lms-analytics.service';
import { LmsRollupService } from './rollup/lms-rollup.service';
import { yesterdayUtc } from './rollup/lms-rollup.util';
import { CertificationExpiryService } from './certification-expiry.service';

const MAX_CONTENT_FILE_SIZE_BYTES = 200 * 1024 * 1024;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date.`);
  }
  return date;
}

/** Learning & Development's HTTP surface — see docs/conventions/lms.md. */
@Controller('lms')
export class LmsController {
  constructor(
    private readonly categories: CourseCategoryService,
    private readonly courses: CourseService,
    private readonly enrollments: EnrollmentService,
    private readonly quizzes: QuizService,
    private readonly certifications: CertificationService,
    private readonly requiredTrainings: RequiredTrainingService,
    private readonly compliance: LmsComplianceService,
    private readonly analytics: LmsAnalyticsService,
    private readonly rollup: LmsRollupService,
    private readonly certificationExpiry: CertificationExpiryService,
    private readonly storage: StorageService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // --- Categories ---------------------------------------------------------

  @Post('categories')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('CourseCategory', AUDIT_ACTIONS.CREATE)
  async upsertCategory(@Body(new ZodValidationPipe(createCourseCategorySchema)) body: CreateCourseCategoryInput) {
    return this.categories.upsert(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('categories')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async listCategories() {
    return this.categories.list(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId));
  }

  // --- Courses -------------------------------------------------------------

  @Post('courses')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('Course', AUDIT_ACTIONS.CREATE)
  async createCourse(@Body(new ZodValidationPipe(createCourseSchema)) body: CreateCourseInput) {
    return this.courses.create(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, body);
  }

  @Get('courses')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async listCourses(@Query('status') status?: string, @Query('categoryId') categoryId?: string) {
    return this.courses.list(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.hasPermission(PERMISSIONS.LMS_AUTHOR),
      { status, categoryId },
    );
  }

  @Get('courses/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async getCourse(@Param('id') id: string) {
    return this.courses.findById(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.hasPermission(PERMISSIONS.LMS_AUTHOR),
    );
  }

  @Put('courses/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('Course', AUDIT_ACTIONS.UPDATE)
  async updateCourse(@Param('id') id: string, @Body(new ZodValidationPipe(updateCourseSchema)) body: UpdateCourseInput) {
    return this.courses.update(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id, body);
  }

  @Post('courses/:id/publish')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('Course', AUDIT_ACTIONS.UPDATE)
  async publishCourse(@Param('id') id: string) {
    return this.courses.publish(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  @Post('courses/:id/archive')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('Course', AUDIT_ACTIONS.UPDATE)
  async archiveCourse(@Param('id') id: string) {
    return this.courses.archive(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  // --- Content items ---------------------------------------------------------

  @Post('courses/:id/content')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('CourseContentItem', AUDIT_ACTIONS.CREATE)
  async addContentItem(@Param('id') id: string, @Body(new ZodValidationPipe(createContentItemSchema)) body: CreateContentItemInput) {
    return this.courses.addContentItem(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id, body);
  }

  @Post('courses/:id/content/:itemId/file')
  @UseInterceptors(PermissionsGuard, FileInterceptor('file', { limits: { fileSize: MAX_CONTENT_FILE_SIZE_BYTES } }))
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  async uploadContentFile(@Param('id') id: string, @Param('itemId') itemId: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('A "file" multipart field is required.');
    }
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const storageKey = `lms/${tenantId}/${id}/${itemId}-${Date.now()}-${file.originalname}`;
    await this.storage.uploadObject({ key: storageKey, body: file.buffer, contentType: file.mimetype });
    return this.courses.setContentItemStorageKey(this.tenantContext.getTx(), tenantId, id, itemId, storageKey);
  }

  @Get('courses/:id/content/:itemId/file')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async downloadContentFile(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const item = await this.courses.requireContentItem(this.tenantContext.getTx(), tenantId, id, itemId);
    if (!item.storageKey) {
      throw new BadRequestException('This content item has no uploaded file.');
    }
    const { body, contentType } = await this.storage.downloadObject(item.storageKey);
    res.set({ 'Content-Type': contentType ?? 'application/octet-stream' });
    return new StreamableFile(body);
  }

  @Delete('courses/:id/content/:itemId')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('CourseContentItem', AUDIT_ACTIONS.DELETE)
  async removeContentItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    await this.courses.removeContentItem(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id, itemId);
    return { removed: true };
  }

  // --- Quiz ------------------------------------------------------------------

  @Put('courses/:id/quiz')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('Quiz', AUDIT_ACTIONS.UPDATE)
  async upsertQuiz(@Param('id') id: string, @Body(new ZodValidationPipe(upsertQuizSchema)) body: UpsertQuizInput) {
    return this.quizzes.upsertQuiz(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id, body);
  }

  @Post('courses/:id/quiz/questions')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  @AuditLog('QuizQuestion', AUDIT_ACTIONS.CREATE)
  async addQuizQuestion(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createQuizQuestionSchema)) body: CreateQuizQuestionInput,
  ): Promise<QuizQuestion> {
    return this.quizzes.addQuestion(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id, body);
  }

  @Get('courses/:id/quiz')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async getQuizForTaking(@Param('id') id: string) {
    return this.quizzes.getForTaking(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  @Get('courses/:id/quiz/admin')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_AUTHOR)
  async getQuizForAdmin(@Param('id') id: string) {
    return this.quizzes.getForAdmin(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  // --- Enrollment ------------------------------------------------------------

  @Post('courses/:id/enroll')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_ENROLL)
  @AuditLog('Enrollment', AUDIT_ACTIONS.CREATE)
  async enroll(@Param('id') id: string) {
    return this.enrollments.enroll(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, id);
  }

  @Post('courses/:id/assign')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_ASSIGN)
  @AuditLog('Enrollment', AUDIT_ACTIONS.CREATE)
  async assign(@Param('id') id: string, @Body(new ZodValidationPipe(assignEnrollmentSchema)) body: AssignEnrollmentInput) {
    return this.enrollments.assign(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, id, body);
  }

  @Get('enrollments/me')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async myEnrollments() {
    return this.enrollments.listMine(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!);
  }

  @Get('enrollments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async listEnrollments(
    @Query('employeeId') employeeId?: string,
    @Query('courseId') courseId?: string,
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.enrollments.list(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.LMS_MANAGE),
      this.tenantContext.getBranchIds(),
      { employeeId, courseId, status, branchId },
    );
  }

  @Get('enrollments/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async getEnrollment(@Param('id') id: string) {
    return this.enrollments.findById(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.LMS_MANAGE),
      id,
    );
  }

  @Post('enrollments/:id/content/:itemId/complete')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_ENROLL)
  @AuditLog('ContentProgress', AUDIT_ACTIONS.UPDATE)
  async markContentComplete(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.enrollments.markContentComplete(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.LMS_MANAGE),
      id,
      itemId,
    );
  }

  @Post('enrollments/:id/quiz/attempts')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_ENROLL)
  @AuditLog('QuizAttempt', AUDIT_ACTIONS.CREATE)
  async submitQuizAttempt(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitQuizAttemptSchema)) body: SubmitQuizAttemptInput,
  ): Promise<QuizAttempt> {
    return this.quizzes.submitAttempt(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), this.tenantContext.userId!, id, body);
  }

  @Get('enrollments/:id/quiz/attempts')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async listQuizAttempts(@Param('id') id: string): Promise<QuizAttempt[]> {
    return this.quizzes.listAttempts(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  // --- Certifications ---------------------------------------------------------

  @Get('certifications/me')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async myCertifications() {
    const tx = this.tenantContext.getTx();
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const own = await tx.employee.findFirst({ where: { tenantId, userId: this.tenantContext.userId! }, select: { id: true } });
    if (!own) {
      return [];
    }
    return this.certifications.listForEmployee(tx, tenantId, own.id);
  }

  @Get('certifications')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  async listCertifications(@Query('employeeId') employeeId?: string, @Query('courseId') courseId?: string, @Query('status') status?: string) {
    return this.certifications.list(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), { employeeId, courseId, status });
  }

  // --- Required training --------------------------------------------------

  @Post('required-trainings')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  @AuditLog('RequiredTraining', AUDIT_ACTIONS.CREATE)
  async createRequiredTraining(@Body(new ZodValidationPipe(upsertRequiredTrainingSchema)) body: UpsertRequiredTrainingInput) {
    return this.requiredTrainings.create(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('required-trainings')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  async listRequiredTrainings(@Query('courseId') courseId?: string) {
    return this.requiredTrainings.list(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), { courseId });
  }

  @Delete('required-trainings/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  @AuditLog('RequiredTraining', AUDIT_ACTIONS.DELETE)
  async deactivateRequiredTraining(@Param('id') id: string) {
    return this.requiredTrainings.deactivate(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  // --- Compliance + calendar + analytics --------------------------------------

  @Get('compliance/gaps')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  async complianceGaps(@Query('branchId') branchId?: string, @Query('courseId') courseId?: string) {
    if (!branchId) {
      throw new BadRequestException('branchId is required.');
    }
    return this.compliance.listGaps(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), branchId, this.tenantContext.getBranchIds(), {
      courseId,
    });
  }

  @Get('compliance/dashboard')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  async complianceDashboard(@Query('branchId') branchId?: string, @Query('courseId') courseId?: string, @Query('to') toRaw?: string) {
    const to = parseDate(toRaw, 'to') ?? yesterdayUtc();
    const tx = this.tenantContext.getTx();
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const allowedBranchIds = this.tenantContext.getBranchIds();
    const [completion, compliance] = await Promise.all([
      this.analytics.courseCompletion(tx, tenantId, allowedBranchIds, { to, branchId, courseId }),
      this.analytics.trainingCompliance(tx, tenantId, allowedBranchIds, { to, branchId, courseId }),
    ]);
    return { completion, compliance };
  }

  @Get('calendar')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_READ)
  async calendar(@Query('from') fromRaw?: string, @Query('to') toRaw?: string, @Query('branchId') branchId?: string) {
    const from = parseDate(fromRaw, 'from') ?? new Date();
    const to = parseDate(toRaw, 'to') ?? addDays(from, 30);
    if (from > to) {
      throw new BadRequestException('from must be on or before to.');
    }
    return this.compliance.calendar(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.LMS_MANAGE),
      this.tenantContext.getBranchIds(),
      { from, to, branchId },
    );
  }

  /** Manual backfill/test lever — the SAME "manual trigger, HR/admin lever" shape 1.5's own `POST /analytics/rollup/run` establishes; this module's own job IS scheduled (see LmsRollupService), this route exists for backfill and tests. */
  @Post('rollup/run')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  async runRollup(@Body(new ZodValidationPipe(runLmsRollupSchema)) body: RunLmsRollupInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.rollup.enqueueTenantRollup(tenantId, body.date ?? yesterdayUtc());
    return { enqueued: true };
  }

  /** Manual backfill/test lever for the certification-expiry reminder sweep — same shape as `POST /lms/rollup/run` above. */
  @Post('certifications/expiry-sweep/run')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.LMS_MANAGE)
  async runExpirySweep() {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.certificationExpiry.enqueueTenantSweep(tenantId);
    return { enqueued: true };
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
