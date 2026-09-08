/** `entityType` this module registers with 0.9's audit sink (see docs/conventions/audit-custom-fields.md) and its own row-error/summary records. */
export const IMPORT_BATCH_ENTITY_TYPE = 'ImportBatch';

export const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * How long a COMMITTED/COMMITTED_WITH_ERRORS/FAILED batch's uploaded source
 * file is kept in object storage before `MigrationPurgeService` removes it —
 * see docs/conventions/data-migration.md's "never store raw uploaded PII
 * files longer than needed" note. A batch still `UPLOADED`/`VALIDATING`/
 * `DRY_RUN_COMPLETE`/`COMMITTING` is never purged, regardless of age — only
 * a TERMINAL batch's file is eligible.
 */
export const IMPORT_FILE_RETENTION_HOURS = Number(process.env.IMPORT_FILE_RETENTION_HOURS ?? 72);

export const IMPORT_BATCH_TERMINAL_STATUSES = ['COMMITTED', 'COMMITTED_WITH_ERRORS', 'FAILED'] as const;
