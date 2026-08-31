import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Res, StreamableFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { PayrollComponentDefinition } from '@hrm/db';
import { createPayrollComponentSchema, CreatePayrollComponentInput, FEATURE_FLAGS, PERMISSIONS, runPayrollSchema, RunPayrollInput } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PermissionSerializerInterceptor } from '../common/permissions/permission-serializer.interceptor';
import { RequireFeature } from '../licensing/require-feature.decorator';
import { FeatureFlagGuard } from '../licensing/feature-flag.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { StorageService } from '../storage/storage.service';
import { PayrollRunLineResponseDto, PayrollRunResponseDto } from './payroll-response.dto';
import { PayrollRunService } from './runs/payroll-run.service';
import { PayrollComponentDefinitionService } from './components/payroll-component-definition.service';
import { PayslipService } from './payslip/payslip.service';
import { PayrollBankExportService } from './bank-export/payroll-bank-export.service';

/**
 * The Payroll module's API surface — see docs/conventions/payroll.md.
 * Every route requires BOTH the `multi_country_payroll` feature flag
 * (already seeded since 0.6 in anticipation of exactly this module) and
 * the relevant permission — the SAME two-decorator shape 0.6/0.4 already
 * establish together elsewhere. Deliberately NO approve/reject route —
 * THE RULE (docs/conventions/workflow.md), identical to Leave/Attendance:
 * a run's approval happens via the generic
 * `POST /workflow/instances/:id/steps/:stepId/actions`.
 */
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly runs: PayrollRunService,
    private readonly components: PayrollComponentDefinitionService,
    private readonly payslips: PayslipService,
    private readonly bankExports: PayrollBankExportService,
    private readonly tenantContext: TenantContextService,
    private readonly storage: StorageService,
  ) {}

  @Post('runs')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_RUN)
  @AuditLog('PayrollRun', 'CREATE')
  async createRun(@Body(new ZodValidationPipe(runPayrollSchema)) body: RunPayrollInput) {
    this.runs.assertBranchAllowed(body.branchId, this.tenantContext.getBranchIds());
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const run = await this.runs.createRun(this.tenantContext.getTx(), tenantId, this.tenantContext.userId!, body.branchId, body.periodYear, body.periodMonth);
    return toRunDto(run);
  }

  @Post('runs/:id/calculate')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_RUN)
  @AuditLog('PayrollRun', 'CALCULATE')
  async calculate(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.runs.calculate(tx, tenantId, id);
    return { enqueued: true };
  }

  @Get('runs/:id')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, PermissionSerializerInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_RUN)
  async getRun(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());
    const lines = await tx.payrollRunLine.findMany({ where: { payrollRunId: id }, orderBy: { createdAt: 'asc' } });
    return toRunDto(run, lines.map(toLineDto));
  }

  @Post('runs/:id/submit-for-approval')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_RUN)
  @AuditLog('PayrollRun', 'SUBMIT_FOR_APPROVAL')
  async submitForApproval(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    await this.runs.submitForApproval(tx, tenantId, this.tenantContext.userId!, id);
    return { submitted: true };
  }

  @Post('runs/:id/finalize')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_APPROVE)
  @AuditLog('PayrollRun', 'FINALIZE')
  async finalize(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());
    await this.runs.finalize(tx, id);
    return { finalized: true };
  }

  @Post('runs/:id/mark-paid')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_APPROVE)
  @AuditLog('PayrollRun', 'MARK_PAID')
  async markPaid(@Param('id') id: string) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());
    await this.runs.markPaid(tx, id);
    return { paid: true };
  }

  /**
   * Deliberately NOT `@AuditLog`'d — the SAME reason
   * `EmployeeDocumentsController.download` (1.1) isn't: this returns a
   * `StreamableFile` wrapping a live Node stream, and `AuditInterceptor`
   * captures whatever a handler returns as the audit row's `after` value
   * — recursively redacting a stream's own deeply self-referential
   * internal structure overflows the stack. The durable record of this
   * action IS the `PayrollBankExport` row `PayrollBankExportService.
   * generate` creates (who, when, which format) — the same "the DB row
   * itself is the record" posture document upload/download already take.
   */
  @Post('runs/:id/bank-export')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_APPROVE)
  async bankExport(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());
    const { storageKey, format } = await this.bankExports.generate(tx, requireTenantId(this.tenantContext.tenantId), id, this.tenantContext.userId!);
    const { body, contentType } = await this.storage.downloadObject(storageKey);
    res.set({ 'Content-Type': contentType ?? 'text/csv', 'Content-Disposition': `attachment; filename="payroll-${id}-${format}.csv"` });
    return new StreamableFile(body);
  }

  @Get('runs/:id/payslips/:employeeId')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.EMPLOYEE_READ)
  async payslip(@Param('id') id: string, @Param('employeeId') employeeId: string, @Res({ passthrough: true }) res: Response) {
    const tx = this.tenantContext.getTx();
    const run = await this.runs.requireRun(tx, id);
    this.runs.assertBranchAllowed(run.branchId, this.tenantContext.getBranchIds());

    const canViewAny = this.tenantContext.hasPermission(PERMISSIONS.PAYSLIP_VIEW);
    if (!canViewAny) {
      const own = await tx.employee.findFirst({ where: { userId: this.tenantContext.userId! }, select: { id: true } });
      if (!own || own.id !== employeeId) {
        throw new ForbiddenException('You may only view your own payslip.');
      }
    }

    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
    const line = await tx.payrollRunLine.findFirst({ where: { payrollRunId: id, employeeId } });
    if (!line) {
      throw new BadRequestException('No payroll line exists for this employee on this run.');
    }

    const storageKey = await this.payslips.getStorageKey(tx, tenantId, tenant.name, line.id);
    const { body, contentType } = await this.storage.downloadObject(storageKey);
    res.set({ 'Content-Type': contentType ?? 'application/pdf', 'Content-Disposition': `attachment; filename="payslip-${employeeId}.pdf"` });
    return new StreamableFile(body);
  }

  @Post('components')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard, AuditInterceptor)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_RUN)
  @AuditLog('PayrollComponentDefinition', 'UPSERT')
  async upsertComponent(@Body(new ZodValidationPipe(createPayrollComponentSchema)) body: CreatePayrollComponentInput): Promise<PayrollComponentDefinition> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.components.upsert(this.tenantContext.getTx(), tenantId, body);
  }

  @Get('components')
  @UseInterceptors(FeatureFlagGuard, PermissionsGuard)
  @RequireFeature(FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL)
  @RequirePermissions(PERMISSIONS.PAYROLL_RUN)
  async listComponents(@Query('countryCode') countryCode?: string): Promise<PayrollComponentDefinition[]> {
    return this.components.list(this.tenantContext.getTx(), countryCode);
  }
}

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

function toRunDto(
  run: {
    id: string;
    branchId: string;
    periodYear: number;
    periodMonth: number;
    status: string;
    payrollMode: string;
    workflowInstanceId: string | null;
    currencyCode: string;
    totalGross: { toString(): string };
    totalNet: { toString(): string };
    totalEmployerCost: { toString(): string };
    totalGrossBase: { toString(): string } | null;
    totalNetBase: { toString(): string } | null;
    createdAt: Date;
  },
  lines?: PayrollRunLineResponseDto[],
): PayrollRunResponseDto {
  return new PayrollRunResponseDto({
    id: run.id,
    branchId: run.branchId,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    status: run.status,
    payrollMode: run.payrollMode,
    workflowInstanceId: run.workflowInstanceId,
    currencyCode: run.currencyCode,
    totalGross: run.totalGross.toString(),
    totalNet: run.totalNet.toString(),
    totalEmployerCost: run.totalEmployerCost.toString(),
    totalGrossBase: run.totalGrossBase?.toString() ?? null,
    totalNetBase: run.totalNetBase?.toString() ?? null,
    createdAt: run.createdAt.toISOString(),
    lines,
  });
}

function toLineDto(line: {
  id: string;
  employeeId: string;
  status: string;
  computedVia: string | null;
  grossPay: { toString(): string } | null;
  netPay: { toString(): string } | null;
  employerCost: { toString(): string } | null;
  componentBreakdown: unknown;
  errorMessage: string | null;
  computedAt: Date | null;
}): PayrollRunLineResponseDto {
  return new PayrollRunLineResponseDto({
    id: line.id,
    employeeId: line.employeeId,
    status: line.status,
    computedVia: line.computedVia,
    grossPay: line.grossPay?.toString() ?? null,
    netPay: line.netPay?.toString() ?? null,
    employerCost: line.employerCost?.toString() ?? null,
    componentBreakdown: line.componentBreakdown,
    errorMessage: line.errorMessage,
    computedAt: line.computedAt?.toISOString() ?? null,
  });
}
