import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import type { BenefitEnrollment, BenefitPlan, BenefitPlanTier } from '@hrm/db';
import { AUDIT_ACTIONS, createBenefitEnrollmentSchema, CreateBenefitEnrollmentInput, createBenefitPlanSchema, CreateBenefitPlanInput, PERMISSIONS } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PermissionSerializerInterceptor } from '../common/permissions/permission-serializer.interceptor';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { BenefitPlanService } from './benefit-plan.service';
import { BenefitEnrollmentService } from './benefit-enrollment.service';
import { BenefitsStatutoryService } from './benefits-statutory.service';
import { BenefitsCostReportService } from './benefits-cost-report.service';
import { BenefitCostReportPlanLineDto, BenefitCostReportResponseDto, BenefitCostReportStatutoryLineDto } from './benefits-response.dto';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * Benefits Administration's HTTP surface — see
 * docs/conventions/benefits.md. Deliberately no approve/reject route for
 * an enrollment pending approval — THE RULE: act via the generic
 * `POST /workflow/instances/:id/steps/:stepId/actions`, keyed off the
 * `workflowInstanceId` returned on `GET /benefits/enrollments/:id`.
 */
@Controller('benefits')
export class BenefitsController {
  constructor(
    private readonly plans: BenefitPlanService,
    private readonly enrollments: BenefitEnrollmentService,
    private readonly statutory: BenefitsStatutoryService,
    private readonly costReport: BenefitsCostReportService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('plans')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BENEFITS_MANAGE)
  @AuditLog('BenefitPlan', AUDIT_ACTIONS.CREATE)
  async upsertPlan(@Body(new ZodValidationPipe(createBenefitPlanSchema)) body: CreateBenefitPlanInput): Promise<BenefitPlan & { tiers: BenefitPlanTier[] }> {
    return this.plans.upsert(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), body);
  }

  @Get('plans')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BENEFITS_READ)
  async listPlans(@Query('isActive') isActive?: string): Promise<(BenefitPlan & { tiers: BenefitPlanTier[] })[]> {
    return this.plans.list(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), {
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
  }

  @Get('plans/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BENEFITS_READ)
  async getPlan(@Param('id') id: string): Promise<BenefitPlan & { tiers: BenefitPlanTier[] }> {
    return this.plans.findById(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), id);
  }

  @Get('statutory')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BENEFITS_READ)
  async listStatutory(@Query('branchId') branchId: string) {
    if (!branchId) {
      throw new BadRequestException('A "branchId" query parameter is required.');
    }
    return this.statutory.listForBranch(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), branchId);
  }

  @Post('enrollments')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BENEFITS_ENROLL)
  @AuditLog('BenefitEnrollment', AUDIT_ACTIONS.CREATE)
  async enroll(@Body(new ZodValidationPipe(createBenefitEnrollmentSchema)) body: CreateBenefitEnrollmentInput): Promise<BenefitEnrollment> {
    return this.enrollments.enroll(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.BENEFITS_MANAGE),
      this.tenantContext.getBranchIds(),
      body,
    );
  }

  @Post('enrollments/:id/cancel')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.BENEFITS_ENROLL)
  @AuditLog('BenefitEnrollment', AUDIT_ACTIONS.UPDATE)
  async cancel(@Param('id') id: string): Promise<BenefitEnrollment> {
    return this.enrollments.cancel(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.BENEFITS_MANAGE),
    );
  }

  @Get('enrollments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BENEFITS_READ)
  async listEnrollments(@Query('employeeId') employeeId?: string, @Query('planId') planId?: string, @Query('status') status?: string) {
    return this.enrollments.list(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.BENEFITS_MANAGE),
      this.tenantContext.getBranchIds(),
      { employeeId, planId, status },
    );
  }

  @Get('enrollments/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BENEFITS_READ)
  async getEnrollment(@Param('id') id: string) {
    return this.enrollments.findById(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      id,
      this.tenantContext.userId!,
      this.tenantContext.hasPermission(PERMISSIONS.BENEFITS_MANAGE),
      this.tenantContext.getBranchIds(),
    );
  }

  /** The ESS convenience read: the caller's own enrollments, ungated (your own data is never out of scope) — see field-level-permissions.md's "self-service" posture. */
  @Get('my-benefits')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.BENEFITS_READ)
  async myBenefits() {
    return this.enrollments.list(
      this.tenantContext.getTx(),
      requireTenantId(this.tenantContext.tenantId),
      this.tenantContext.userId!,
      false,
      null,
      {},
    );
  }

  @Get('cost-report')
  @UseInterceptors(PermissionsGuard, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.BENEFITS_MANAGE)
  async costReportRoute(
    @Query('periodYear') periodYear: string,
    @Query('periodMonth') periodMonth: string,
    @Query('branchId') branchId?: string,
  ): Promise<BenefitCostReportResponseDto> {
    if (!periodYear || !periodMonth) {
      throw new BadRequestException('"periodYear" and "periodMonth" query parameters are required.');
    }
    const report = await this.costReport.generate(this.tenantContext.getTx(), requireTenantId(this.tenantContext.tenantId), {
      periodYear: Number(periodYear),
      periodMonth: Number(periodMonth),
      branchId,
      allowedBranchIds: this.tenantContext.getBranchIds(),
    });
    return new BenefitCostReportResponseDto({
      periodYear: report.periodYear,
      periodMonth: report.periodMonth,
      plans: report.plans.map((line) => new BenefitCostReportPlanLineDto(line)),
      statutory: report.statutory.map((line) => new BenefitCostReportStatutoryLineDto(line)),
    });
  }
}
