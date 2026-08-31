import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { StorageService } from '../../storage/storage.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { BANK_EXPORT_ADAPTER, BankExportAdapter, BankExportLineInput } from './bank-export-adapter.interface';

/**
 * Bank-payment-file-export orchestration — see docs/conventions/payroll.md.
 * Only runs already `FINALIZED`/`PAID` may be exported (a control point:
 * you don't hand a bank a payment file for a run still under approval).
 * Decrypts bank details here (1.1 `EncryptionService`) so
 * `BankExportAdapter` implementations stay pure formatting logic with no
 * DB/crypto dependency of their own.
 */
@Injectable()
export class PayrollBankExportService {
  constructor(
    @Inject(BANK_EXPORT_ADAPTER) private readonly adapter: BankExportAdapter,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
  ) {}

  async generate(tx: Prisma.TransactionClient, tenantId: string, runId: string, callerUserId: string): Promise<{ storageKey: string; format: string }> {
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'FINALIZED' && run.status !== 'PAID') {
      throw new ConflictException(`Payroll run "${runId}" must be FINALIZED (or PAID) before a bank export can be generated (is "${run.status}").`);
    }

    const lines = await tx.payrollRunLine.findMany({ where: { payrollRunId: runId, status: 'COMPUTED' }, include: { employee: true } });
    const inputs: BankExportLineInput[] = lines.map((line) => ({
      line,
      employeeCode: line.employee.employeeCode,
      employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
      bankAccountNumber: line.employee.bankAccountNumberEncrypted ? this.encryption.decrypt(line.employee.bankAccountNumberEncrypted) : null,
      bankName: line.employee.bankNameEncrypted ? this.encryption.decrypt(line.employee.bankNameEncrypted) : null,
    }));

    const file = this.adapter.generate(run, inputs);
    const storageKey = `payroll/${tenantId}/${runId}/bank-export-${Date.now()}.csv`;
    await this.storage.uploadObject({ key: storageKey, body: file.body, contentType: file.contentType });

    await tx.payrollBankExport.create({
      data: { tenantId, payrollRunId: runId, format: file.format, storageKey, generatedByUserId: callerUserId },
    });

    return { storageKey, format: file.format };
  }
}
