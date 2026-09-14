import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { STATUTORY_REPORT_QUEUE } from '../queue/queue.constants';
import { shouldAutorunWorkers } from '../queue/queue-worker.util';
import { resolvePayrollPackConfig } from '../payroll/payroll-pack.util';
import { StorageService } from '../storage/storage.service';
import { StatutoryReportPdfService } from './statutory-report-pdf.service';
import { StatutoryReportCsvService } from './statutory-report-csv.service';
import { STATUTORY_REPORT_GENERATOR_REGISTRY, StatutoryReportGeneratorRegistry } from './statutory-report-generator.interface';
import type { StatutoryReportJobData } from './statutory-report-queue.service';

/**
 * The report-generation job's WORKER side — see
 * docs/conventions/statutory-reporting.md. Context-less (no
 * `TenantContextService`), the same posture every other BullMQ processor in
 * this codebase already takes. A whole report is generated as ONE atomic
 * unit (unlike `PayrollRunProcessor`'s per-employee resumability — there is
 * no meaningful "half a report" to resume, so a retried job just
 * regenerates the whole thing from scratch, safely, since every write here
 * either fully replaces `GeneratedReport`'s own row or is a fresh idempotent
 * storage upload keyed by this report's own id).
 */
@Processor(STATUTORY_REPORT_QUEUE, { autorun: shouldAutorunWorkers() })
export class StatutoryReportProcessor extends WorkerHost {
  constructor(
    @Inject(STATUTORY_REPORT_GENERATOR_REGISTRY) private readonly registry: StatutoryReportGeneratorRegistry,
    private readonly pdf: StatutoryReportPdfService,
    private readonly csv: StatutoryReportCsvService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<StatutoryReportJobData>): Promise<void> {
    const { tenantId, generatedReportId } = job.data;

    await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      await tx.generatedReport.update({ where: { id: generatedReportId }, data: { status: 'GENERATING' } });
    });

    try {
      const { data, tenantName, branchName, definitionOutputFormats, complianceNote } = await withTenantContext(
        tenantId,
        async (tx: Prisma.TransactionClient) => {
          const report = await tx.generatedReport.findUniqueOrThrow({ where: { id: generatedReportId } });
          const [branch, tenant, definition] = await Promise.all([
            tx.branch.findUniqueOrThrow({ where: { id: report.branchId }, select: { name: true } }),
            tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
            tx.statutoryReportDefinition.findUniqueOrThrow({ where: { id: report.reportDefinitionId } }),
          ]);
          const pack = await resolvePayrollPackConfig(tx, tenantId, report.branchId);

          const generator = this.registry.resolve(report.reportCode);
          if (!generator) {
            throw new Error(`No statutory report generator is registered for report code "${report.reportCode}".`);
          }

          const data = await generator.generate(tx, {
            tenantId,
            branchId: report.branchId,
            branchName: branch.name,
            countryCode: report.countryCode,
            currencyCode: pack.config.locale.currencyCode,
            language: pack.config.payslipTemplate.language,
            periodYear: report.periodYear,
            periodMonth: report.periodMonth ?? undefined,
            periodQuarter: report.periodQuarter ?? undefined,
          });

          return { data, tenantName: tenant.name, branchName: branch.name, definitionOutputFormats: definition.outputFormats, complianceNote: definition.complianceNote };
        },
      );

      let pdfStorageKey: string | null = null;
      let csvStorageKey: string | null = null;

      if (definitionOutputFormats.includes('PDF')) {
        const pdfBytes = await this.pdf.render({ data, tenantName, branchName, complianceNote });
        pdfStorageKey = `statutory-reports/${tenantId}/${generatedReportId}.pdf`;
        await this.storage.uploadObject({ key: pdfStorageKey, body: pdfBytes, contentType: 'application/pdf' });
      }
      if (definitionOutputFormats.includes('CSV')) {
        const csvBytes = this.csv.render(data);
        csvStorageKey = `statutory-reports/${tenantId}/${generatedReportId}.csv`;
        await this.storage.uploadObject({ key: csvStorageKey, body: csvBytes, contentType: 'text/csv' });
      }

      await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
        await tx.generatedReport.update({
          where: { id: generatedReportId },
          data: {
            status: 'COMPLETED',
            pdfStorageKey,
            csvStorageKey,
            summary: { employeeCount: data.rows.length, totals: data.totals } as Prisma.InputJsonValue,
            errorMessage: null,
            generatedAt: new Date(),
          },
        });
      });
    } catch (error) {
      await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
        await tx.generatedReport.update({
          where: { id: generatedReportId },
          data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message : String(error) },
        });
      });
      throw error;
    }
  }
}
