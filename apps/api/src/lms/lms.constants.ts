/**
 * Learning & Development (LMS, step 3.2) — see docs/conventions/lms.md.
 * The SAME "one recurring job, registered idempotently on every app boot"
 * pattern 1.5's AnalyticsRollupService established — two independent
 * scheduled jobs here (completion/compliance rollup, certification-expiry
 * reminders), each with its OWN queue/job-id/cron, since they run on
 * different cadences and neither should block the other.
 */
export const LMS_ROLLUP_ORCHESTRATOR_JOB_ID = 'lms-rollup-daily-orchestrator';
export const LMS_ROLLUP_ORCHESTRATOR_CRON = '0 3 * * *';

export const LMS_EXPIRY_ORCHESTRATOR_JOB_ID = 'lms-certification-expiry-daily-orchestrator';
export const LMS_EXPIRY_ORCHESTRATOR_CRON = '0 4 * * *';

/** Reminder buckets for the certification-expiry job — see CertificationExpiryService. */
export const CERTIFICATION_EXPIRY_REMINDER_WINDOW_DAYS = 30;
export const CERTIFICATION_EXPIRY_URGENT_WINDOW_DAYS = 7;
