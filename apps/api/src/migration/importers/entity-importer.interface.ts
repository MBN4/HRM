import type { Prisma } from '@hrm/db';
import type { ImportEntityTypeKey } from '@hrm/shared';
import type { ImportRowOutcome } from '../migration-row-runner';

export interface StagedRow {
  rowNumber: number;
  mappedRow: Record<string, string>;
  /** `null` when this row's own `processRow` failed — `finalize` skips it. */
  outcome: ImportRowOutcome | null;
}

/**
 * One importer per `ImportEntityType` — see docs/conventions/data-migration.md.
 * Every importer is a THIN adapter: `processRow` maps+coerces one row and
 * routes the actual write/validation through the REAL module service
 * (`EmployeeService`, `LeaveBalanceService`, ...) — never reimplementing
 * country-pack/statutory/encryption/entitlement logic itself. Natural-key
 * upsert (find-by-code-or-name, then CREATE or UPDATE) is what makes a
 * commit idempotent — see `MigrationCommitService`'s own doc comment.
 */
export interface EntityImporter {
  readonly entityType: ImportEntityTypeKey;

  /**
   * Maps + validates + (only when called via a COMMIT run) writes exactly
   * one row. Throws on any validation failure (a `BadRequestException`
   * from the real service, or one raised here for an unresolved natural-key
   * reference) — `runImportRow` is what turns that into a row-level
   * `{ ok: false }` outcome, and what forces a DRY-RUN call's transaction to
   * roll back regardless of outcome. `allowedBranchIds` is threaded through
   * unchanged from the caller (`null` = unrestricted) purely so a future
   * caller can tighten this — see data-migration.md's documented scope note
   * on why importing itself does not currently enforce branch scoping.
   */
  processRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    importBatchId: string,
    allowedBranchIds: string[] | null,
    mappedRow: Record<string, string>,
  ): Promise<ImportRowOutcome>;

  /**
   * Optional second pass over every row ONCE ALL of them have been staged
   * (see EMPLOYEE's manager-by-code resolution, the one entity this brief
   * calls out by name) — returns extra per-row error messages keyed by
   * `rowNumber`, appended to that row's own `ImportRowError`s without
   * altering the CREATE/UPDATE/SKIP outcome `processRow` already recorded
   * for it (the primary entity still exists even if this secondary link
   * fails to resolve).
   */
  finalize?(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    commit: boolean,
    rows: StagedRow[],
  ): Promise<Map<number, string>>;
}
