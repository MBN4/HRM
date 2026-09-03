/** THE RULE (workflow.md): a payroll run's approval is JUST a WorkflowInstance — this module owns no approve/reject logic of its own. */
export const PAYROLL_RUN_ENTITY_TYPE = 'PayrollRun';

/** `AttendanceDailySummary.status` values counted as an unpaid day for gross-pay pro-ration — see docs/conventions/payroll.md. */
export const UNPAID_ATTENDANCE_STATUS = 'ABSENT';

/** The reference bank-export format bound today — see docs/conventions/payroll.md's bank-export seam note. */
export const GENERIC_CSV_BANK_EXPORT_FORMAT = 'GENERIC_CSV';

/**
 * Step 3.3 — formalizes the bank-export seam into a genuinely PLUGGABLE
 * registry (`BankExportAdapterRegistry`), proven by a SECOND registered
 * format. `NACHA_STUB` is honestly a stub, not a real NACHA file — see
 * `nacha-stub-bank-export.adapter.ts`'s doc comment — it exists to prove
 * `PayrollRun.bankExportFormat` actually selects between adapters, not to
 * close payroll.md's own documented "no real country-specific format" gap.
 */
export const NACHA_STUB_BANK_EXPORT_FORMAT = 'NACHA_STUB';
