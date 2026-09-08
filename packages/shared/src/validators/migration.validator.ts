import { z } from 'zod';

/**
 * Data migration & onboarding toolkit (step 3.5.1) — see
 * docs/conventions/data-migration.md. This module owns NO
 * employee/leave/country-pack validation logic of its own — every importer
 * routes the mapped, coerced row through the REAL module service
 * (`EmployeeService.create`/`.update`, `LeaveBalanceService`, ...), so the
 * schemas here only shape the IMPORT-specific envelope: which entity type,
 * which columns map to which of our fields, and the batch/mapping-template
 * records themselves.
 */
export const IMPORT_ENTITY_TYPES = [
  'BRANCH',
  'DEPARTMENT',
  'DESIGNATION',
  'COST_CENTER',
  'EMPLOYEE',
  'LEAVE_BALANCE',
  'ATTENDANCE_HISTORY',
  'PAYSLIP_HISTORY',
] as const;
export type ImportEntityTypeKey = (typeof IMPORT_ENTITY_TYPES)[number];

export const IMPORT_MODES = ['PARTIAL', 'ALL_OR_NOTHING'] as const;
export type ImportModeKey = (typeof IMPORT_MODES)[number];

export const IMPORT_FILE_FORMATS = ['CSV', 'XLSX'] as const;
export type ImportFileFormatKey = (typeof IMPORT_FILE_FORMATS)[number];

export interface ImportFieldSpec {
  /** Our own field name — the target side of the column mapping. */
  key: string;
  /** Human-readable label for the mapping-step UI. */
  label: string;
  required: boolean;
}

/**
 * The mappable field catalog per entity type — pure data, shared by the
 * portal/admin mapping-step UI (renders one row per spec) and the backend
 * (`assertColumnMappingComplete` below rejects a mapping missing a
 * required key before any file is even parsed). Which of an EMPLOYEE row's
 * fields are ACTUALLY required beyond this list (country-pack-driven
 * statutory fields, e.g. US SSN/W4) is resolved by the real
 * `EmployeeService`/Country Pack machinery at validate/commit time, never
 * duplicated here — see data-migration.md.
 */
export const IMPORT_ENTITY_FIELDS: Record<ImportEntityTypeKey, readonly ImportFieldSpec[]> = {
  BRANCH: [
    { key: 'name', label: 'Branch name', required: true },
    { key: 'countryCode', label: 'Country code (2-letter)', required: true },
    { key: 'timezone', label: 'Timezone (IANA)', required: true },
    { key: 'parentBranchName', label: 'Parent branch name', required: false },
  ],
  DEPARTMENT: [
    { key: 'name', label: 'Department name', required: true },
    { key: 'branchName', label: 'Branch name', required: true },
    { key: 'parentDepartmentName', label: 'Parent department name', required: false },
  ],
  DESIGNATION: [{ key: 'name', label: 'Designation name', required: true }],
  COST_CENTER: [
    { key: 'name', label: 'Cost center name', required: true },
    { key: 'code', label: 'Cost center code', required: true },
  ],
  EMPLOYEE: [
    { key: 'employeeCode', label: 'Employee code', required: true },
    { key: 'firstName', label: 'First name', required: true },
    { key: 'lastName', label: 'Last name', required: true },
    { key: 'personalEmail', label: 'Personal email', required: false },
    { key: 'phone', label: 'Phone', required: false },
    { key: 'dateOfBirth', label: 'Date of birth', required: false },
    { key: 'gender', label: 'Gender', required: false },
    { key: 'branchName', label: 'Branch name', required: true },
    { key: 'departmentName', label: 'Department name', required: false },
    { key: 'designationName', label: 'Designation name', required: false },
    { key: 'employmentType', label: 'Employment type', required: true },
    { key: 'joinDate', label: 'Join date', required: true },
    { key: 'managerEmployeeCode', label: "Manager's employee code", required: false },
    { key: 'statutoryFieldsJson', label: 'Statutory fields (JSON object)', required: false },
    { key: 'bankAccountNumber', label: 'Bank account number', required: false },
    { key: 'bankName', label: 'Bank name', required: false },
    { key: 'bankRoutingCode', label: 'Bank routing code', required: false },
    { key: 'baseSalary', label: 'Base salary', required: false },
    { key: 'salaryCurrency', label: 'Salary currency (3-letter)', required: false },
  ],
  LEAVE_BALANCE: [
    { key: 'employeeCode', label: 'Employee code', required: true },
    { key: 'leaveType', label: 'Leave type', required: true },
    { key: 'periodYear', label: 'Period year', required: true },
    { key: 'accruedDays', label: 'Accrued/opening days', required: true },
    { key: 'carriedOverDays', label: 'Carried-over days', required: false },
  ],
  ATTENDANCE_HISTORY: [
    { key: 'employeeCode', label: 'Employee code', required: true },
    { key: 'workDate', label: 'Work date', required: true },
    { key: 'status', label: 'Day status', required: true },
    { key: 'workedMinutes', label: 'Worked minutes', required: false },
    { key: 'overtimeMinutes', label: 'Overtime minutes', required: false },
    { key: 'note', label: 'Note', required: false },
  ],
  PAYSLIP_HISTORY: [
    { key: 'employeeCode', label: 'Employee code', required: true },
    { key: 'periodYear', label: 'Period year', required: true },
    { key: 'periodMonth', label: 'Period month', required: true },
    { key: 'currencyCode', label: 'Currency code (3-letter)', required: true },
    { key: 'grossPay', label: 'Gross pay', required: true },
    { key: 'netPay', label: 'Net pay', required: true },
    { key: 'note', label: 'Note', required: false },
  ],
};

/** `{ [ourFieldKey]: "client's column header" }`. */
export const columnMappingSchema = z.record(z.string().min(1), z.string().min(1));
export type ColumnMappingInput = z.infer<typeof columnMappingSchema>;

/** Every required field for `entityType` must have a mapping entry — checked before any file parsing, so a client sees a clear 400 rather than a wall of per-row errors caused by one missing column. */
export function assertColumnMappingComplete(entityType: ImportEntityTypeKey, mapping: ColumnMappingInput): string[] {
  const required = IMPORT_ENTITY_FIELDS[entityType].filter((f) => f.required).map((f) => f.key);
  return required.filter((key) => !mapping[key] || mapping[key].trim().length === 0);
}

export const createImportBatchMetadataSchema = z
  .object({
    entityType: z.enum(IMPORT_ENTITY_TYPES),
    fileFormat: z.enum(IMPORT_FILE_FORMATS),
    mode: z.enum(IMPORT_MODES).default('PARTIAL'),
    columnMapping: columnMappingSchema,
    columnMappingTemplateId: z.string().uuid().optional(),
  })
  .strict();
export type CreateImportBatchMetadataInput = z.infer<typeof createImportBatchMetadataSchema>;

export const saveColumnMappingTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    entityType: z.enum(IMPORT_ENTITY_TYPES),
    mapping: columnMappingSchema,
  })
  .strict();
export type SaveColumnMappingTemplateInput = z.infer<typeof saveColumnMappingTemplateSchema>;

/** `POST /platform/tenants/:tenantId/migration/batches` body's metadata field re-shapes identically — a vendor admin runs the same importer on a tenant's behalf, see docs/conventions/vendor-console.md. */
export const platformCreateImportBatchMetadataSchema = createImportBatchMetadataSchema;
export type PlatformCreateImportBatchMetadataInput = z.infer<typeof platformCreateImportBatchMetadataSchema>;
