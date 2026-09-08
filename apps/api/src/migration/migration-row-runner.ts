import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';

export type ImportRowStatus = 'CREATE' | 'UPDATE' | 'SKIP';

export interface ImportRowOutcome {
  status: ImportRowStatus;
  entityId?: string;
}

export type RowRunResult = { ok: true; value: ImportRowOutcome } | { ok: false; message: string };

/** Thrown ONLY internally by `runImportRow` to force its own transaction to roll back after a dry-run row "succeeded" — never allowed to escape this file. */
class DryRunRollback extends Error {
  constructor(readonly value: ImportRowOutcome) {
    super('dry-run-rollback');
  }
}

/**
 * THE mechanism that makes a dry run trustworthy without duplicating a
 * single line of real validation logic (see docs/conventions/data-migration.md
 * → "how dry-run reuses real validation"): every importer's `processRow`
 * calls the SAME real module service (`EmployeeService.create`, ...) either
 * way. For a COMMIT, this just runs it inside one fresh `withTenantContext`
 * transaction — the SAME per-row-transaction shape 1.1's
 * `EmployeeImportProcessor` already established (one bad row can never roll
 * back rows that already succeeded). For a DRY RUN, it runs the EXACT same
 * call inside its own transaction too, but then deliberately throws a
 * private sentinel wrapping the result — forcing Postgres to roll the
 * transaction back regardless of whether the row "succeeded" — so a dry run
 * can never write anything, by construction, not by convention. A row that
 * fails real validation throws its own (different) error, which propagates
 * out as `{ ok: false }` on both paths identically.
 */
export async function runImportRow(
  tenantId: string,
  commit: boolean,
  fn: (tx: Prisma.TransactionClient) => Promise<ImportRowOutcome>,
): Promise<RowRunResult> {
  try {
    if (commit) {
      const value = await withTenantContext(tenantId, fn);
      return { ok: true, value };
    }

    await withTenantContext(tenantId, async (tx) => {
      const value = await fn(tx);
      throw new DryRunRollback(value);
    });
    /* istanbul ignore next -- withTenantContext above always either returns via the throw below or propagates the DryRunRollback/real error caught in the catch block */
    throw new Error('unreachable');
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return { ok: true, value: error.value };
    }
    return { ok: false, message: error instanceof Error ? error.message : 'Unknown error.' };
  }
}
