/** THE RULE (workflow.md): a payroll run's approval is JUST a WorkflowInstance — this module owns no approve/reject logic of its own. */
export const PAYROLL_RUN_ENTITY_TYPE = 'PayrollRun';

/** `AttendanceDailySummary.status` values counted as an unpaid day for gross-pay pro-ration — see docs/conventions/payroll.md. */
export const UNPAID_ATTENDANCE_STATUS = 'ABSENT';

/** The reference bank-export format bound today — see docs/conventions/payroll.md's bank-export seam note. */
export const GENERIC_CSV_BANK_EXPORT_FORMAT = 'GENERIC_CSV';
