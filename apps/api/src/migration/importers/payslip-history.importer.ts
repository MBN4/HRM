import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@hrm/db';
import { emptyToUndefined } from '../file-parsing/parse-import-file';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter } from './entity-importer.interface';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Historical payslip/payroll data, kept scoped and READ-ONLY per the brief
 * — see docs/conventions/data-migration.md. Deliberately NOT a real
 * `PayrollRun`/`PayrollRunLine` (2.1): this toolkit never recomputes
 * historical payroll (no tax/statutory engine call, ever) — it only
 * carries the client's own already-final historical totals forward into
 * `MigratedPayslipRecord` for reference. `grossPay`/`netPay` are
 * field-level gated behind `salary.view` at the response DTO layer (see
 * `migration-batch-response.dto.ts`), though — a documented gap, unlike
 * `Employee.baseSalaryEncrypted` — NOT encrypted at rest.
 */
@Injectable()
export class PayslipHistoryImporter implements EntityImporter {
  readonly entityType = 'PAYSLIP_HISTORY' as const;

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    importBatchId: string,
    _allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const employeeCode = mappedRow.employeeCode?.trim();
    if (!employeeCode) throw new BadRequestException('employeeCode is required.');
    const periodYear = Number(mappedRow.periodYear);
    if (!Number.isInteger(periodYear)) throw new BadRequestException('periodYear must be a whole number.');
    const periodMonth = Number(mappedRow.periodMonth);
    if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
      throw new BadRequestException('periodMonth must be a whole number from 1-12.');
    }
    const currencyCode = mappedRow.currencyCode?.trim().toUpperCase();
    if (!currencyCode || !CURRENCY_CODE_PATTERN.test(currencyCode)) {
      throw new BadRequestException('currencyCode must be a 3-letter currency code.');
    }
    const grossPay = parseMoney(mappedRow.grossPay, 'grossPay');
    const netPay = parseMoney(mappedRow.netPay, 'netPay');

    const employee = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode } } });
    if (!employee) throw new BadRequestException(`employeeCode "${employeeCode}" was not found — import employees first.`);

    const row = await tx.migratedPayslipRecord.create({
      data: {
        tenantId,
        importBatchId,
        employeeId: employee.id,
        periodYear,
        periodMonth,
        currencyCode,
        grossPay,
        netPay,
        note: emptyToUndefined(mappedRow.note) ?? null,
      },
    });
    return { status: 'CREATE', entityId: row.id };
  }
}

function parseMoney(value: string | undefined, field: string): Prisma.Decimal {
  const raw = value?.trim();
  if (!raw || Number.isNaN(Number(raw))) {
    throw new BadRequestException(`${field} must be a valid amount.`);
  }
  return new Prisma.Decimal(raw);
}
