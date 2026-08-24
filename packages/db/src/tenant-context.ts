import { PrismaClient, Prisma } from '@prisma/client';
import { appPrisma } from './clients';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(tenantId: string) {
    super(`Invalid tenant id: "${tenantId}" is not a UUID.`);
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * Runs `fn` inside a Postgres transaction with `app.current_tenant` bound to
 * `tenantId` for that transaction only, via `set_config(..., true)` — the
 * parameterized equivalent of `SET LOCAL`. Row-Level Security policies read
 * that setting to filter every tenant-scoped table (see the
 * `enable_row_level_security` migration).
 *
 * A transaction is what makes "set the context, run, reset" safe on a
 * pooled connection: `set_config(..., true)` is transaction-local, so
 * Postgres resets it automatically at COMMIT/ROLLBACK — no manual reset
 * step, and no way for tenant A's context to leak into a later request that
 * reuses the same underlying connection. If calling code ever forgets to go
 * through this helper, the RLS policy's `current_setting` call (no
 * missing_ok) raises a hard Postgres error instead of silently returning
 * zero rows or another tenant's data.
 *
 * `client` defaults to `appPrisma`, the restricted `hrm_app`-role client
 * RLS is actually enforced against — `prisma` (the migration/owner client)
 * always bypasses RLS and must never be passed here.
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = appPrisma,
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}
