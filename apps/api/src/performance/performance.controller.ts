import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import {
  assignPeerReviewersSchema,
  AssignPeerReviewersInput,
  createAppraisalCycleSchema,
  CreateAppraisalCycleInput,
  createGoalSchema,
  CreateGoalInput,
  createRatingScaleSchema,
  CreateRatingScaleInput,
  PERMISSIONS,
  submitReviewSchema,
  SubmitReviewInput,
  updateGoalProgressSchema,
  UpdateGoalProgressInput,
} from '@hrm/shared';
import type { AppraisalCycle, RatingScale } from '@hrm/db';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { RatingScaleService } from './rating-scales/rating-scale.service';
import { AppraisalCycleService } from './cycles/appraisal-cycle.service';
import { GoalService } from './goals/goal.service';
import { AppraisalService } from './appraisals/appraisal.service';
import { ReviewService } from './reviews/review.service';
import { CalibrationService } from './calibration/calibration.service';
import { CalibrationQueueService } from './calibration/calibration-queue.service';
import type { AppraisalDetail } from './appraisals/appraisal.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The Performance module's HTTP surface — see docs/conventions/performance.md.
 * Deliberately no approve/reject route for appraisal sign-off — THE RULE
 * (docs/conventions/workflow.md), identical to Leave/Attendance/Payroll: a
 * pending sign-off is acted on via the generic
 * `POST /workflow/instances/:id/steps/:stepId/actions`, using the
 * `workflowInstanceId` returned on `GET /performance/appraisals/:id`.
 */
@Controller('performance')
export class PerformanceController {
  constructor(
    private readonly ratingScales: RatingScaleService,
    private readonly cycles: AppraisalCycleService,
    private readonly goals: GoalService,
    private readonly appraisals: AppraisalService,
    private readonly reviews: ReviewService,
    private readonly calibration: CalibrationService,
    private readonly calibrationQueue: CalibrationQueueService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('rating-scales')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  @AuditLog('RatingScale', 'UPSERT')
  async upsertRatingScale(@Body(new ZodValidationPipe(createRatingScaleSchema)) body: CreateRatingScaleInput): Promise<RatingScale> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.ratingScales.upsert(this.tenantContext.getTx(), tenantId, body);
  }

  @Get('rating-scales')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_READ)
  async listRatingScales(): Promise<RatingScale[]> {
    return this.ratingScales.list(this.tenantContext.getTx());
  }

  @Post('cycles')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  @AuditLog('AppraisalCycle', 'CREATE')
  async createCycle(@Body(new ZodValidationPipe(createAppraisalCycleSchema)) body: CreateAppraisalCycleInput): Promise<AppraisalCycle> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.cycles.create(this.tenantContext.getTx(), tenantId, body);
  }

  @Post('cycles/:id/open')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  @AuditLog('AppraisalCycle', 'OPEN')
  async openCycle(@Param('id') id: string): Promise<AppraisalCycle> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.cycles.open(this.tenantContext.getTx(), tenantId, id);
  }

  @Post('cycles/:id/close')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  @AuditLog('AppraisalCycle', 'CLOSE')
  async closeCycle(@Param('id') id: string): Promise<AppraisalCycle> {
    return this.cycles.close(this.tenantContext.getTx(), id);
  }

  @Get('cycles')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_READ)
  async listCycles(): Promise<AppraisalCycle[]> {
    return this.cycles.list(this.tenantContext.getTx());
  }

  @Get('cycles/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_READ)
  async getCycle(@Param('id') id: string): Promise<AppraisalCycle> {
    return this.cycles.requireCycle(this.tenantContext.getTx(), id);
  }

  @Get('cycles/:id/calibration')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  async getCalibration(@Param('id') id: string, @Query('branchId') branchId?: string) {
    return this.calibration.getDistribution(this.tenantContext.getTx(), id, this.tenantContext.getBranchIds(), branchId);
  }

  /** Manual backfill/test lever — the SAME shape `AnalyticsController`'s own `POST /analytics/rollup/run` already establishes. */
  @Post('cycles/:id/calibration/recompute')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  async recomputeCalibration(@Param('id') id: string) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.calibrationQueue.enqueueRecompute(tenantId, id);
    return { enqueued: true };
  }

  @Post('goals')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_WRITE)
  @AuditLog('Goal', 'CREATE')
  async createGoal(@Body(new ZodValidationPipe(createGoalSchema)) body: CreateGoalInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.PERFORMANCE_MANAGE);
    return this.goals.create(this.tenantContext.getTx(), tenantId, this.tenantContext.userId!, canManage, this.tenantContext.getBranchIds(), body);
  }

  @Get('goals')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_READ)
  async listGoals(
    @Query('employeeId') employeeId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('level') level?: string,
    @Query('cycleId') cycleId?: string,
    @Query('branchId') branchId?: string,
  ) {
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.PERFORMANCE_MANAGE);
    return this.goals.list(this.tenantContext.getTx(), this.tenantContext.userId!, canManage, this.tenantContext.getBranchIds(), {
      employeeId,
      departmentId,
      level,
      cycleId,
      branchId,
    });
  }

  @Patch('goals/:id/progress')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_WRITE)
  @AuditLog('Goal', 'UPDATE')
  async updateGoalProgress(@Param('id') id: string, @Body(new ZodValidationPipe(updateGoalProgressSchema)) body: UpdateGoalProgressInput) {
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.PERFORMANCE_MANAGE);
    return this.goals.updateProgress(this.tenantContext.getTx(), id, this.tenantContext.userId!, canManage, this.tenantContext.getBranchIds(), body);
  }

  @Get('appraisals')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_READ)
  async listAppraisals(
    @Query('cycleId') cycleId?: string,
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
  ) {
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.PERFORMANCE_MANAGE);
    return this.appraisals.list(this.tenantContext.getTx(), this.tenantContext.userId!, canManage, this.tenantContext.getBranchIds(), {
      cycleId,
      employeeId,
      status,
      branchId,
    });
  }

  @Get('appraisals/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_READ)
  async getAppraisal(@Param('id') id: string): Promise<AppraisalDetail> {
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.PERFORMANCE_MANAGE);
    return this.appraisals.findById(this.tenantContext.getTx(), id, this.tenantContext.userId!, canManage, this.tenantContext.getBranchIds());
  }

  @Post('appraisals/:id/peer-assignments')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  @AuditLog('ReviewAssignment', 'CREATE')
  async assignPeers(@Param('id') id: string, @Body(new ZodValidationPipe(assignPeerReviewersSchema)) body: AssignPeerReviewersInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.reviews.assignPeers(this.tenantContext.getTx(), tenantId, id, body);
  }

  @Post('appraisals/:id/submit-for-approval')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_MANAGE)
  @AuditLog('Appraisal', 'SUBMIT_FOR_APPROVAL')
  async submitForApproval(@Param('id') id: string) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.appraisals.submitForApproval(this.tenantContext.getTx(), tenantId, this.tenantContext.userId!, id);
    return { submitted: true };
  }

  @Get('my-review-assignments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_REVIEW)
  async myReviewAssignments() {
    return this.reviews.myAssignments(this.tenantContext.getTx(), this.tenantContext.userId!);
  }

  @Post('review-assignments/:id/submit')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.PERFORMANCE_REVIEW)
  @AuditLog('Review', 'CREATE')
  async submitReview(@Param('id') id: string, @Body(new ZodValidationPipe(submitReviewSchema)) body: SubmitReviewInput) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.reviews.submit(this.tenantContext.getTx(), tenantId, id, this.tenantContext.userId!, body);
  }
}
