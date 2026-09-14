/** `@AuditLog` entity type for a generated report row — see docs/conventions/statutory-reporting.md. */
export const GENERATED_REPORT_ENTITY_TYPE = 'GeneratedReport';

/** `PayrollRun.status` values a statutory report is allowed to read from — the SAME "FINALIZED or PAID" gate `PayrollBankExportService` already enforces for bank export. A run still DRAFT/CALCULATED/APPROVED is never reported. */
export const REPORTABLE_PAYROLL_RUN_STATUSES = ['FINALIZED', 'PAID'] as const;
