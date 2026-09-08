import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { createEmployeeSchema, updateEmployeeSchema } from '@hrm/shared';
import { EmployeeService } from '../../employees/employee.service';
import { emptyToUndefined } from '../file-parsing/parse-import-file';
import type { ImportRowOutcome } from '../migration-row-runner';
import type { EntityImporter, StagedRow } from './entity-importer.interface';

/**
 * THE primary importer — routes creation/update through the REAL 1.1
 * `EmployeeService` exactly like a direct `POST`/`PATCH /employees` call
 * would, so country-driven required fields (US SSN/W4 vs. QA QatarID/visa),
 * encryption of bank/salary, and every other `EmployeeService` rule are
 * enforced identically — see docs/conventions/employee.md and
 * docs/conventions/data-migration.md. Natural key: `(tenantId,
 * employeeCode)`, the SAME `@@unique` the real employee create already
 * enforces — an existing employeeCode is UPDATED, never duplicated, which
 * is what makes re-importing the same file (or the same batch retried)
 * safe.
 *
 * `managerId` is DELIBERATELY never set here — see `finalize` below, the
 * one place this brief calls out by name ("resolve the manager graph after
 * rows are staged"): a manager row may appear LATER in the file than its
 * reports, so the link can only be resolved once every row has been
 * staged, not row-by-row on a single forward pass.
 */
@Injectable()
export class EmployeeImporter implements EntityImporter {
  readonly entityType = 'EMPLOYEE' as const;

  constructor(private readonly employees: EmployeeService) {}

  async processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    _importBatchId: string,
    allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome> {
    const employeeCode = mappedRow.employeeCode?.trim();
    if (!employeeCode) throw new BadRequestException('employeeCode is required.');

    const branchName = mappedRow.branchName?.trim();
    if (!branchName) throw new BadRequestException('branchName is required.');
    const branch = await tx.branch.findFirst({ where: { tenantId, name: branchName }, select: { id: true } });
    if (!branch) throw new BadRequestException(`branchName "${branchName}" was not found — import branches first.`);

    const departmentName = emptyToUndefined(mappedRow.departmentName);
    const departmentId = departmentName
      ? (
          await tx.department.findFirst({ where: { tenantId, branchId: branch.id, name: departmentName }, select: { id: true } })
        )?.id
      : undefined;
    if (departmentName && !departmentId) {
      throw new BadRequestException(`departmentName "${departmentName}" was not found in branch "${branchName}".`);
    }

    const designationName = emptyToUndefined(mappedRow.designationName);
    const designationId = designationName
      ? (await tx.designation.findFirst({ where: { tenantId, name: designationName }, select: { id: true } }))?.id
      : undefined;
    if (designationName && !designationId) {
      throw new BadRequestException(`designationName "${designationName}" was not found.`);
    }

    const candidate = this.buildCandidate(mappedRow, branch.id, departmentId, designationId);

    const existing = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode } } });
    if (existing) {
      const parsed = updateEmployeeSchema.parse(candidate);
      const row = await this.employees.update(tx, tenantId, existing.id, parsed, allowedBranchIds);
      return { status: 'UPDATE', entityId: row.id };
    }
    const parsed = createEmployeeSchema.parse({ ...candidate, employeeCode });
    const row = await this.employees.create(tx, tenantId, parsed, allowedBranchIds);
    return { status: 'CREATE', entityId: row.id };
  }

  async finalize(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    commit: boolean,
    rows: StagedRow[],
  ): Promise<Map<number, string>> {
    const errors = new Map<number, string>();
    const stagedCodes = new Set(
      rows.filter((r) => r.outcome !== null).map((r) => r.mappedRow.employeeCode?.trim()).filter((c): c is string => !!c),
    );

    for (const row of rows) {
      if (!row.outcome) continue; // this row's own create/update already failed — nothing to link.
      const managerCode = emptyToUndefined(row.mappedRow.managerEmployeeCode?.trim());
      if (!managerCode) continue;
      const employeeCode = row.mappedRow.employeeCode?.trim();
      if (managerCode === employeeCode) {
        errors.set(row.rowNumber, 'managerEmployeeCode cannot reference the employee\'s own employeeCode.');
        continue;
      }

      if (commit) {
        const manager = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode: managerCode } } });
        if (!manager) {
          errors.set(row.rowNumber, `Employee created/updated, but managerEmployeeCode "${managerCode}" was not found.`);
          continue;
        }
        const employee = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode } } });
        if (!employee) continue; // should not happen — this row's own outcome was non-null.
        await this.employees.update(tx, tenantId, employee.id, { managerId: manager.id }, allowedBranchIds);
      } else {
        // Dry run: nothing was written, so "resolves" means the code
        // matches either an employee already in the DB or another row in
        // THIS batch that would itself succeed — see the class doc comment.
        if (stagedCodes.has(managerCode)) continue;
        const manager = await tx.employee.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode: managerCode } } });
        if (!manager) {
          errors.set(row.rowNumber, `managerEmployeeCode "${managerCode}" does not match any employee in this file or already on record.`);
        }
      }
    }

    return errors;
  }

  private buildCandidate(
    mappedRow: Record<string, string>,
    branchId: string,
    departmentId: string | undefined,
    designationId: string | undefined,
  ): Record<string, unknown> {
    const bankAccountNumber = emptyToUndefined(mappedRow.bankAccountNumber);
    const bankName = emptyToUndefined(mappedRow.bankName);
    const baseSalary = emptyToUndefined(mappedRow.baseSalary);
    const salaryCurrency = emptyToUndefined(mappedRow.salaryCurrency);

    return {
      firstName: mappedRow.firstName?.trim(),
      lastName: mappedRow.lastName?.trim(),
      personalEmail: emptyToUndefined(mappedRow.personalEmail),
      phone: emptyToUndefined(mappedRow.phone),
      dateOfBirth: emptyToUndefined(mappedRow.dateOfBirth),
      gender: emptyToUndefined(mappedRow.gender),
      branchId,
      departmentId,
      designationId,
      employmentType: mappedRow.employmentType?.trim(),
      joinDate: mappedRow.joinDate?.trim(),
      statutoryFields: parseStatutoryFieldsJson(emptyToUndefined(mappedRow.statutoryFieldsJson)),
      bankDetails: bankAccountNumber && bankName ? { accountNumber: bankAccountNumber, bankName, routingCode: emptyToUndefined(mappedRow.bankRoutingCode) } : undefined,
      compensation: baseSalary && salaryCurrency ? { baseSalary: Number(baseSalary), salaryCurrency } : undefined,
    };
  }
}

function parseStatutoryFieldsJson(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BadRequestException('statutoryFieldsJson must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('statutoryFieldsJson must be a JSON object of string values.');
  }
  return parsed as Record<string, string>;
}
