import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { GeneratedReport, Prisma, StatutoryReportPeriodType } from '@hrm/db';
import { resolvePayrollPackConfig } from '../payroll/payroll-pack.util';
import { StatutoryReportQueueService } from './statutory-report-queue.service';

export interface GenerateStatutoryReportParams {
  branchId: string;
  reportCode: string;
  periodYear: number;
  periodMonth?: number;
  periodQuarter?: number;
}

/**
 * `MONTHLY`/`QUARTERLY`/`ANNUAL` -> a single string uniqueness anchor — see
 * the `GeneratedReport` model's own doc comment in schema.prisma for why
 * this sidesteps a nullable-compound-unique's NULL-is-distinct trap.
 */
function computePeriodKey(periodType: StatutoryReportPeriodType, periodYear: number, periodMonth?: number, periodQuarter?: number): string {
  if (periodType === 'MONTHLY') {
    if (!periodMonth) {
      throw new BadRequestException('"periodMonth" is required for a MONTHLY report.');
    }
    return `${periodYear}-${String(periodMonth).padStart(2, '0')}`;
  }
  if (periodType === 'QUARTERLY') {
    if (!periodQuarter) {
      throw new BadRequestException('"periodQuarter" is required for a QUARTERLY report.');
    }
    return `${periodYear}-Q${periodQuarter}`;
  }
  return `${periodYear}`;
}

/**
 * Statutory reporting ORCHESTRATION — resolving which report/period was
 * asked for and enqueuing the actual generation job, never the aggregation
 * itself (see `StatutoryReportProcessor`/the `generators/*`). See
 * docs/conventions/statutory-reporting.md.
 */
@Injectable()
export class StatutoryReportService {
  constructor(private readonly queue: StatutoryReportQueueService) {}

  /** The country-extensibility proof surface: `GET /statutory-reports/definitions?branchId=` resolves whatever the branch's OWN country has defined — zero branching on country code here. */
  async listDefinitionsForBranch(tx: Prisma.TransactionClient, branchId: string) {
    const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { countryCode: true } });
    if (!branch) {
      throw new NotFoundException(`Branch "${branchId}" was not found.`);
    }
    return tx.statutoryReportDefinition.findMany({ where: { countryCode: branch.countryCode, isActive: true }, orderBy: { reportCode: 'asc' } });
  }

  async generate(tx: Prisma.TransactionClient, tenantId: string, callerUserId: string, params: GenerateStatutoryReportParams): Promise<GeneratedReport> {
    const branch = await tx.branch.findUnique({ where: { id: params.branchId }, select: { id: true, countryCode: true } });
    if (!branch) {
      throw new NotFoundException(`Branch "${params.branchId}" was not found.`);
    }
    // Fail fast at request time if this branch's country has no active
    // CountryPack at all — the SAME "no missing_ok" posture Country Pack
    // resolution already holds itself to, rather than surfacing a
    // resolution error only deep inside the queued job later.
    await resolvePayrollPackConfig(tx, tenantId, branch.id);

    const definition = await tx.statutoryReportDefinition.findUnique({
      where: { countryCode_reportCode: { countryCode: branch.countryCode, reportCode: params.reportCode } },
    });
    if (!definition || !definition.isActive) {
      throw new NotFoundException(`No active statutory report "${params.reportCode}" is defined for country "${branch.countryCode}".`);
    }

    const periodKey = computePeriodKey(definition.periodType, params.periodYear, params.periodMonth, params.periodQuarter);

    const report = await tx.generatedReport.upsert({
      where: { tenantId_branchId_reportDefinitionId_periodKey: { tenantId, branchId: branch.id, reportDefinitionId: definition.id, periodKey } },
      update: { status: 'PENDING', errorMessage: null, requestedByUserId: callerUserId },
      create: {
        tenantId,
        branchId: branch.id,
        reportDefinitionId: definition.id,
        reportCode: definition.reportCode,
        countryCode: branch.countryCode,
        periodType: definition.periodType,
        periodYear: params.periodYear,
        periodMonth: params.periodMonth ?? null,
        periodQuarter: params.periodQuarter ?? null,
        periodKey,
        status: 'PENDING',
        requestedByUserId: callerUserId,
      },
    });

    await this.queue.enqueueGenerate(tenantId, report.id);
    return report;
  }

  /** A pure read — an out-of-scope `branchId` filter returns `[]`, never a 403, matching `PayrollRunService.findMany`'s own branch-scoping posture for LIST reads. */
  async findMany(
    tx: Prisma.TransactionClient,
    filters: { branchId?: string; reportCode?: string; periodYear?: number },
    allowedBranchIds: string[] | null,
  ): Promise<GeneratedReport[]> {
    if (filters.branchId && allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
      return [];
    }
    const where: Prisma.GeneratedReportWhereInput = {
      ...(filters.branchId ? { branchId: filters.branchId } : allowedBranchIds ? { branchId: { in: allowedBranchIds } } : {}),
      ...(filters.reportCode ? { reportCode: filters.reportCode } : {}),
      ...(filters.periodYear ? { periodYear: filters.periodYear } : {}),
    };
    return tx.generatedReport.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async requireById(tx: Prisma.TransactionClient, id: string): Promise<GeneratedReport> {
    const report = await tx.generatedReport.findUnique({ where: { id } });
    if (!report) {
      throw new NotFoundException(`Generated report "${id}" was not found.`);
    }
    return report;
  }

  assertBranchAllowed(branchId: string, allowedBranchIds: string[] | null): void {
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException('You are not permitted to act on statutory reports for this branch.');
    }
  }
}
