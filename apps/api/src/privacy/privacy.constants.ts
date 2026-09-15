/**
 * Data privacy & residency (step 6.1) — see
 * docs/conventions/privacy-residency.md. The SAME "orchestrate -> fan out"
 * scheduled-job shape every prior scheduled job in this codebase already
 * establishes (`AnalyticsRollupService`, `PartitionMaintenanceService`, ...).
 */
export const RETENTION_ENFORCEMENT_ORCHESTRATOR_JOB_ID = 'privacy-retention-enforcement-daily-orchestrator';
/** Daily, offset from every other scheduled job's own cron so they don't all fire the same minute (analytics 0 2, LMS 0 3/0 4, billing 0 4, partitioning 0 1/0 5). */
export const RETENTION_ENFORCEMENT_ORCHESTRATOR_CRON = '0 6 * * *';

export const DATA_SUBJECT_REQUEST_ENTITY_TYPE = 'DataSubjectRequest';
export const CONSENT_RECORD_ENTITY_TYPE = 'ConsentRecord';
export const TENANT_DATA_RETENTION_OVERRIDE_ENTITY_TYPE = 'TenantDataRetentionOverride';

export const PRIVACY_EXPORT_STORAGE_PREFIX = 'privacy-exports';
