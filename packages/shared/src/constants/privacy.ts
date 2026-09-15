/**
 * Data privacy & residency (step 6.1) — see
 * docs/conventions/privacy-residency.md.
 *
 * Mirrors Prisma's `DataSubjectType`/`PrivacyRequestType`/
 * `PrivacyRequestStatus`/`DataCategory`/`RetentionAction` enums
 * (packages/db/prisma/schema.prisma) — the SAME "closed set duplicated as a
 * plain constant so packages/shared's zod validators don't need to import
 * the generated Prisma client" pattern `PARTITIONED_TABLE_NAMES`/
 * `TENANT_EDITIONS` already establish for their own Prisma enums.
 */
export const DATA_SUBJECT_TYPES = ['EMPLOYEE', 'CANDIDATE', 'USER'] as const;
export type DataSubjectTypeKey = (typeof DATA_SUBJECT_TYPES)[number];

export const PRIVACY_REQUEST_TYPES = ['EXPORT', 'ERASURE'] as const;
export type PrivacyRequestTypeKey = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED'] as const;
export type PrivacyRequestStatusKey = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const DATA_CATEGORIES = [
  'EMPLOYEE_PROFILE',
  'EMPLOYEE_POST_EXIT',
  'CANDIDATE_RECORDS',
  'PAYROLL_TAX_RECORDS',
  'AUDIT_TRAIL',
  'DOCUMENTS',
] as const;
export type DataCategoryKey = (typeof DATA_CATEGORIES)[number];

export const RETENTION_ACTIONS = ['HARD_DELETE', 'ANONYMIZE', 'RETAIN_LEGAL'] as const;
export type RetentionActionKey = (typeof RETENTION_ACTIONS)[number];

/**
 * Which `DataCategory` rows are structurally relevant to which
 * `DataSubjectType` — a pure, reviewed code constant (the SAME posture
 * `EDITION_FEATURES`/`PLATFORM_ROLE_PERMISSIONS` already document for
 * themselves: this taxonomy is this module's OWN fixed authoring, not
 * tenant-customizable data). Drives BOTH the erasure engine (which
 * categories it evaluates for a given subject) and the tenant portal's own
 * "which categories apply to me" filtering of the processing register.
 */
export const DATA_CATEGORIES_BY_SUBJECT_TYPE: Record<DataSubjectTypeKey, readonly DataCategoryKey[]> = {
  EMPLOYEE: ['EMPLOYEE_PROFILE', 'EMPLOYEE_POST_EXIT', 'PAYROLL_TAX_RECORDS', 'AUDIT_TRAIL', 'DOCUMENTS'],
  CANDIDATE: ['CANDIDATE_RECORDS', 'AUDIT_TRAIL', 'DOCUMENTS'],
  USER: ['AUDIT_TRAIL'],
};

/** Only these categories are ever auto-purged by the scheduled retention job — see RetentionEnforcementService. The rest (EMPLOYEE_PROFILE while active, PAYROLL_TAX_RECORDS, AUDIT_TRAIL, DOCUMENTS) are RETAIN_LEGAL/handled transitively (see docs/conventions/privacy-residency.md) or acted on only via an explicit, on-demand ERASURE request. */
export const AUTO_ENFORCEABLE_RETENTION_CATEGORIES: readonly DataCategoryKey[] = ['EMPLOYEE_POST_EXIT', 'CANDIDATE_RECORDS'];
