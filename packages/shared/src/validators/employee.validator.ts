import { z } from 'zod';

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;
export type EmploymentTypeKey = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'TERMINATED'] as const;
export type EmployeeStatusKey = (typeof EMPLOYEE_STATUSES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'] as const;
export type GenderKey = (typeof GENDERS)[number];

export const EMPLOYEE_DOCUMENT_TYPES = ['ID_PROOF', 'VISA', 'CONTRACT', 'CERTIFICATE', 'OTHER'] as const;
export type EmployeeDocumentTypeKey = (typeof EMPLOYEE_DOCUMENT_TYPES)[number];

const employeeDependentSchema = z
  .object({
    name: z.string().min(1).max(200),
    relationship: z.string().min(1).max(100),
    dateOfBirth: z.coerce.date().optional(),
  })
  .strict();
export type EmployeeDependentInput = z.infer<typeof employeeDependentSchema>;

const employeeEmergencyContactSchema = z
  .object({
    name: z.string().min(1).max(200),
    relationship: z.string().min(1).max(100),
    phone: z.string().min(1).max(50),
  })
  .strict();
export type EmployeeEmergencyContactInput = z.infer<typeof employeeEmergencyContactSchema>;

/** Plaintext at the API boundary only — EmployeeService encrypts every field here before it ever reaches a Prisma write (see docs/conventions/employee.md). */
const bankDetailsSchema = z
  .object({
    accountNumber: z.string().min(4).max(64),
    bankName: z.string().min(1).max(200),
    routingCode: z.string().min(1).max(64).optional(),
  })
  .strict();
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;

/** Plaintext at the API boundary only — `baseSalary` is encrypted at rest AND field-level gated behind `salary.view` on the way back out (see docs/conventions/field-level-permissions.md). */
const compensationSchema = z
  .object({
    baseSalary: z.number().nonnegative(),
    salaryCurrency: z.string().length(3),
  })
  .strict();
export type CompensationInput = z.infer<typeof compensationSchema>;

/**
 * `{ [statutory field key]: value }` — the KEYS are opaque, defined entirely
 * by the resolved Country Pack's `requiredEmployeeFields` (0.5, e.g.
 * `["SSN","W4"]` for a US branch, `["QATAR_ID","VISA_SPONSORSHIP"]` for a QA
 * one) — this schema only shapes the map itself (string values); WHICH keys
 * are actually required for a given employee is resolved and enforced by
 * `EmployeeService` against `CountryPackResolutionService`, never hardcoded
 * here. See docs/conventions/country-packs.md and
 * docs/conventions/employee.md.
 */
export const statutoryFieldsSchema = z.record(z.string(), z.string());
export type StatutoryFieldsInput = z.infer<typeof statutoryFieldsSchema>;

export const createEmployeeSchema = z
  .object({
    employeeCode: z.string().min(1).max(64),
    userId: z.string().uuid().optional(),
    firstName: z.string().min(1).max(200),
    lastName: z.string().min(1).max(200),
    personalEmail: z.string().email().optional(),
    phone: z.string().min(1).max(50).optional(),
    dateOfBirth: z.coerce.date().optional(),
    gender: z.enum(GENDERS).optional(),
    branchId: z.string().uuid(),
    departmentId: z.string().uuid().optional(),
    designationId: z.string().uuid().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    joinDate: z.coerce.date(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    managerId: z.string().uuid().optional(),
    statutoryFields: statutoryFieldsSchema.optional(),
    bankDetails: bankDetailsSchema.optional(),
    compensation: compensationSchema.optional(),
    dependents: z.array(employeeDependentSchema).optional(),
    emergencyContacts: z.array(employeeEmergencyContactSchema).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/**
 * `PATCH /employees/:id` body — everything from `createEmployeeSchema`
 * except `employeeCode` (immutable once assigned), all optional: an omitted
 * field is left untouched, same "PATCH is a partial update" contract this
 * is the first genuinely partial-update schema in the codebase to need
 * (every prior PUT-style config in this system — Country Pack overrides,
 * feature flag overrides, custom field values — uses full-replace instead).
 * `dependents`/`emergencyContacts`/`customFields`, when PRESENT, still fully
 * replace the employee's existing set for that collection (see
 * docs/conventions/employee.md) — it's only the top-level employee fields
 * themselves that are a true partial patch.
 */
export const updateEmployeeSchema = createEmployeeSchema.omit({ employeeCode: true }).partial().strict();
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

/** `POST /employees/import` body — the CSV content as a string, kept in the request body rather than a multipart upload to match this codebase's existing "one validation paradigm" posture (zod-validated JSON bodies) without adding a second content-type path for this one route. */
export const employeeImportRequestSchema = z.object({ csvContent: z.string().min(1).max(5_000_000) }).strict();
export type EmployeeImportRequestInput = z.infer<typeof employeeImportRequestSchema>;
