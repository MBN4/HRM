import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Body, Query, Res, StreamableFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import type { StatutoryReportDefinition } from '@hrm/db';
import { generateStatutoryReportSchema, GenerateStatutoryReportInput, PERMISSIONS } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PermissionSerializerInterceptor } from '../common/permissions/permission-serializer.interceptor';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { summarizeEntitiesForRows } from '../legal-entities/legal-entity-identity.util';
import { StorageService } from '../storage/storage.service';
import { StatutoryReportService } from './statutory-report.service';
import { GeneratedReportResponseDto } from './statutory-report-response.dto';
import { GENERATED_REPORT_ENTITY_TYPE } from './statutory-reporting.constants';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

function toDto(
  report: {
  id: string;
  branchId: string;
  legalEntityId: string | null;
  reportDefinitionId: string;
  reportCode: string;
  countryCode: string;
  periodType: string;
  periodYear: number;
  periodMonth: number | null;
  periodQuarter: number | null;
  periodKey: string;
  status: string;
  summary: unknown;
  errorMessage: string | null;
  generatedAt: Date | null;
  createdAt: Date;
},
  legalEntity: GeneratedReportResponseDto['legalEntity'] = null,
): GeneratedReportResponseDto {
  return new GeneratedReportResponseDto({
    id: report.id,
    branchId: report.branchId,
    reportDefinitionId: report.reportDefinitionId,
    reportCode: report.reportCode,
    countryCode: report.countryCode,
    legalEntity,
    periodType: report.periodType,
    periodYear: report.periodYear,
    periodMonth: report.periodMonth,
    periodQuarter: report.periodQuarter,
    periodKey: report.periodKey,
    status: report.status,
    summary: report.summary,
    errorMessage: report.errorMessage,
    generatedAt: report.generatedAt?.toISOString() ?? null,
    createdAt: report.createdAt.toISOString(),
  });
}

/**
 * Statutory / government reporting's HTTP surface (step 3.5.4) — see
 * docs/conventions/statutory-reporting.md. `statutory_report.generate`
 * (trigger a new report run) vs. `statutory_report.read` (list the
 * register, view status, download an already-generated report) — the same
 * generate-vs-read split `payroll.run`/`payslip.view` already establish.
 */
@Controller('statutory-reports')
export class StatutoryReportController {
  constructor(
    private readonly reports: StatutoryReportService,
    private readonly tenantContext: TenantContextService,
    private readonly storage: StorageService,
  ) {}

  /** The country-extensibility proof: whatever `StatutoryReportDefinition` rows exist for this branch's OWN resolved country — zero branching on country code in this controller/service. */
  @Get('definitions')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.STATUTORY_REPORT_READ)
  async listDefinitions(@Query('branchId') branchId?: string): Promise<StatutoryReportDefinition[]> {
    if (!branchId) {
      throw new BadRequestException('A "branchId" query parameter is required.');
    }
    this.reports.assertBranchAllowed(branchId, this.tenantContext.getBranchIds());
    return this.reports.listDefinitionsForBranch(this.tenantContext.getTx(), branchId);
  }

  @Post('generate')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.STATUTORY_REPORT_GENERATE)
  @AuditLog(GENERATED_REPORT_ENTITY_TYPE, 'GENERATE')
  async generate(@Body(new ZodValidationPipe(generateStatutoryReportSchema)) body: GenerateStatutoryReportInput): Promise<GeneratedReportResponseDto> {
    this.reports.assertBranchAllowed(body.branchId, this.tenantContext.getBranchIds());
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const report = await this.reports.generate(this.tenantContext.getTx(), tenantId, this.tenantContext.userId!, body);
    return toDto(report, (await summarizeEntitiesForRows(this.tenantContext.getTx(), tenantId, [report])).get(report.id) ?? null);
  }

  @Get()
  @UseInterceptors(PermissionsGuard, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.STATUTORY_REPORT_READ)
  async list(
    @Query('branchId') branchId?: string,
    @Query('reportCode') reportCode?: string,
    @Query('periodYear') periodYear?: string,
    @Query('legalEntityId') legalEntityId?: string,
  ): Promise<GeneratedReportResponseDto[]> {
    if (legalEntityId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(legalEntityId)) {
      throw new BadRequestException('"legalEntityId" must be a UUID.');
    }
    const reports = await this.reports.findMany(
      this.tenantContext.getTx(),
      { branchId, reportCode, periodYear: periodYear ? Number(periodYear) : undefined, legalEntityId },
      this.tenantContext.getBranchIds(),
    );
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const entities = await summarizeEntitiesForRows(this.tenantContext.getTx(), tenantId, reports);
    return reports.map((r) => toDto(r, entities.get(r.id) ?? null));
  }

  @Get(':id')
  @UseInterceptors(PermissionsGuard, PermissionSerializerInterceptor)
  @RequirePermissions(PERMISSIONS.STATUTORY_REPORT_READ)
  async getById(@Param('id') id: string): Promise<GeneratedReportResponseDto> {
    const tx = this.tenantContext.getTx();
    const report = await this.reports.requireById(tx, id);
    this.reports.assertBranchAllowed(report.branchId, this.tenantContext.getBranchIds());
    const entities = await summarizeEntitiesForRows(tx, requireTenantId(this.tenantContext.tenantId), [report]);
    return toDto(report, entities.get(report.id) ?? null);
  }

  /**
   * Deliberately NOT `@AuditLog`'d — the SAME reason
   * `PayrollController.bankExport`/`.payslip` aren't: this returns a
   * `StreamableFile` wrapping a live Node stream, and `AuditInterceptor`
   * capturing that overflows the stack redacting its internals (see
   * docs/conventions/payroll.md's "a real bug caught" note). The durable
   * record of this download IS the `GeneratedReport` row itself.
   */
  @Get(':id/download')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.STATUTORY_REPORT_READ)
  async download(@Param('id') id: string, @Query('format') format: string, @Res({ passthrough: true }) res: Response) {
    const tx = this.tenantContext.getTx();
    const report = await this.reports.requireById(tx, id);
    this.reports.assertBranchAllowed(report.branchId, this.tenantContext.getBranchIds());

    if (report.status !== 'COMPLETED') {
      throw new BadRequestException(`Report "${id}" is not yet COMPLETED (is "${report.status}").`);
    }

    const normalizedFormat = (format ?? 'pdf').toLowerCase();
    const storageKey = normalizedFormat === 'csv' ? report.csvStorageKey : report.pdfStorageKey;
    if (!storageKey) {
      throw new NotFoundException(`This report was not generated in "${normalizedFormat}" format.`);
    }

    const { body, contentType } = await this.storage.downloadObject(storageKey);
    const extension = normalizedFormat === 'csv' ? 'csv' : 'pdf';
    res.set({
      'Content-Type': contentType ?? (extension === 'csv' ? 'text/csv' : 'application/pdf'),
      'Content-Disposition': `attachment; filename="${report.reportCode}-${report.periodKey}.${extension}"`,
    });
    return new StreamableFile(body);
  }
}
