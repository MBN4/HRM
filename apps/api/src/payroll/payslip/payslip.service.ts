import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { resolvePayrollPackConfig } from '../payroll-pack.util';
import type { PayrollComponentLine } from '../engine/payroll-engine.service';
import { findEntityForBranch, toLegalEntityIdentity } from '../../legal-entities/legal-entity-identity.util';
import { StorageService } from '../../storage/storage.service';
import { PayslipPdfService } from './payslip-pdf.service';

/**
 * Payslip generation orchestration — see docs/conventions/payroll.md.
 * Renders from the resolved pack's OWN `payslipTemplate` (never hardcoded
 * copy), stores the PDF via 1.1's `StorageService`/MinIO (metadata in
 * Postgres, bytes in object storage — the SAME pattern
 * `EmployeeDocumentsService` established), then emits
 * `payroll.payslip_ready` — a genuinely new event type this step adds to
 * `NOTIFICATION_EVENT_TYPES`, picked up by the EXISTING notification hub
 * with zero new dispatch code (see docs/conventions/notifications-queues.md).
 */
@Injectable()
export class PayslipService {
  constructor(
    private readonly pdf: PayslipPdfService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async generate(tx: Prisma.TransactionClient, tenantId: string, tenantName: string, runLineId: string): Promise<{ storageKey: string }> {
    const line = await tx.payrollRunLine.findUnique({ where: { id: runLineId }, include: { employee: true, payrollRun: true } });
    if (!line) {
      throw new NotFoundException(`Payroll run line "${runLineId}" was not found.`);
    }
    if (line.status !== 'COMPUTED' || !line.componentBreakdown) {
      throw new BadRequestException('This payroll run line has not been computed yet.');
    }

    const pack = await resolvePayrollPackConfig(tx, tenantId, line.branchId);
    const lineItemLabels = Object.fromEntries(pack.config.payslipTemplate.lineItems.map((item) => [item.key, item.label]));

    // Step 12.1 — the employing entity: the run's stamped entity, else derived from the employee's branch.
    const stamped = line.payrollRun.legalEntityId ? await tx.legalEntity.findUnique({ where: { id: line.payrollRun.legalEntityId } }) : null;
    const entity = stamped ?? (await findEntityForBranch(tx, tenantId, line.branchId));
    const employer = entity ? await toLegalEntityIdentity(tx, entity) : null;

    const pdfBytes = await this.pdf.render({
      tenantName,
      employer,
      employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
      employeeCode: line.employee.employeeCode,
      periodYear: line.payrollRun.periodYear,
      periodMonth: line.payrollRun.periodMonth,
      currencyCode: line.payrollRun.currencyCode,
      language: pack.config.payslipTemplate.language,
      lineItemLabels,
      componentBreakdown: line.componentBreakdown as unknown as PayrollComponentLine[],
    });

    const storageKey = `payroll/${tenantId}/${line.payrollRunId}/${line.employeeId}-payslip.pdf`;
    await this.storage.uploadObject({ key: storageKey, body: pdfBytes, contentType: 'application/pdf' });

    await tx.payslipDocument.upsert({
      where: { tenantId_payrollRunLineId: { tenantId, payrollRunLineId: line.id } },
      update: { storageKey, language: pack.config.payslipTemplate.language, generatedAt: new Date() },
      create: { tenantId, payrollRunLineId: line.id, storageKey, language: pack.config.payslipTemplate.language },
    });

    if (line.employee.userId) {
      this.eventEmitter.emit('payroll.payslip_ready', {
        type: 'payroll.payslip_ready',
        tenantId,
        userId: line.employee.userId,
        payrollRunLineId: line.id,
      });
    }

    return { storageKey };
  }

  async getStorageKey(tx: Prisma.TransactionClient, tenantId: string, tenantName: string, runLineId: string): Promise<string> {
    const existing = await tx.payslipDocument.findUnique({ where: { tenantId_payrollRunLineId: { tenantId, payrollRunLineId: runLineId } } });
    if (existing) {
      return existing.storageKey;
    }
    const { storageKey } = await this.generate(tx, tenantId, tenantName, runLineId);
    return storageKey;
  }
}
