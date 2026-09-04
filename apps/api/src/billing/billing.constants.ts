export const BILLING_SEAT_SYNC_ORCHESTRATOR_JOB_ID = 'billing-seat-sync-daily-orchestrator';
/** Daily, offset from analytics' (0 2) and LMS's own rollup crons so they don't all fire the same minute. */
export const BILLING_SEAT_SYNC_ORCHESTRATOR_CRON = '0 4 * * *';
