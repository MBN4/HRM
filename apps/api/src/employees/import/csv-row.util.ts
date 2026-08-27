import { parse } from 'csv-parse/sync';
import { createEmployeeSchema, CreateEmployeeInput } from '@hrm/shared';

export interface ParsedCsvRow {
  rowNumber: number;
  input: CreateEmployeeInput | null;
  error: string | null;
}

/**
 * Expected header row: `employeeCode,firstName,lastName,personalEmail,
 * phone,dateOfBirth,gender,branchId,departmentId,designationId,
 * employmentType,joinDate,managerId,statutoryFieldsJson`. Every column
 * except `employeeCode`/`firstName`/`lastName`/`branchId`/`employmentType`/
 * `joinDate` may be left blank. `statutoryFieldsJson`, if present, must be a
 * JSON object string (e.g. `"{""SSN"":""123-45-6789"",""W4"":""...""}"` —
 * doubled quotes are standard CSV escaping for a quoted field containing
 * quotes) — kept as a single flexible column rather than one column per
 * possible statutory key, since which keys exist is entirely country-pack
 * driven (see docs/conventions/country-packs.md), not a fixed set a CSV
 * header could enumerate.
 *
 * Re-validates every row against the SAME `createEmployeeSchema` the real
 * `POST /employees` route uses — one source of truth for what a valid
 * employee looks like, whether it arrives via the API directly or a bulk
 * import row.
 */
export function parseEmployeeImportCsv(csvContent: string): ParsedCsvRow[] {
  const records: Record<string, string>[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((record, index) => {
    const rowNumber = index + 2; // +1 for 1-indexing, +1 for the header row
    try {
      const candidate: Record<string, unknown> = {
        employeeCode: record.employeeCode,
        firstName: record.firstName,
        lastName: record.lastName,
        personalEmail: emptyToUndefined(record.personalEmail),
        phone: emptyToUndefined(record.phone),
        dateOfBirth: emptyToUndefined(record.dateOfBirth),
        gender: emptyToUndefined(record.gender),
        branchId: record.branchId,
        departmentId: emptyToUndefined(record.departmentId),
        designationId: emptyToUndefined(record.designationId),
        employmentType: record.employmentType,
        joinDate: record.joinDate,
        managerId: emptyToUndefined(record.managerId),
        statutoryFields: parseStatutoryFieldsJson(record.statutoryFieldsJson),
      };
      const input = createEmployeeSchema.parse(candidate);
      return { rowNumber, input, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid row.';
      return { rowNumber, input: null, error: message };
    }
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function parseStatutoryFieldsJson(value: string | undefined): Record<string, string> | undefined {
  const raw = emptyToUndefined(value);
  if (!raw) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('statutoryFieldsJson must be a JSON object of string values.');
  }
  return parsed as Record<string, string>;
}
