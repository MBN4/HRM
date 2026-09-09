/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Read replicas) —
 * proves, against a REAL streaming (hot-standby) Postgres replica, not a
 * simulation:
 *   1. RLS holds on the replica EXACTLY as it does on the primary —
 *      `current_tenant` is a per-transaction Postgres SETTING
 *      (`set_config(..., true)`), which is orthogonal to WAL streaming (it
 *      is never itself replicated data), so `withReplicaTenantContext`
 *      needed zero new RLS logic — it reuses `withTenantContext` verbatim
 *      against a different underlying client.
 *   2. The replica genuinely rejects writes at the Postgres ENGINE level
 *      (hot standby), independent of and in addition to this codebase
 *      never issuing one there.
 *   3. Read-after-write safety: a just-written record is read correctly
 *      from the PRIMARY even while the replica is DELIBERATELY paused
 *      (`pg_wal_replay_pause()`) and therefore provably lagging — this is
 *      what makes the "primary vs. replica is an explicit choice" rule in
 *      the docs a proven guarantee, not an assumption. The replica is then
 *      resumed and shown to catch up.
 *
 * `APP_REPLICA_DATABASE_URL` is forced BEFORE `@hrm/db` is ever imported —
 * `packages/db/src/clients.ts` reads it once, at module-load time, to
 * decide whether `appReadReplicaPrisma` is a real second client or just an
 * alias for `appPrisma` (see that file's own doc comment) — the same
 * "force process.env before the package import" pattern
 * `apps/api/test/resilience-pool-exhaustion.e2e-spec.ts` already
 * establishes for the exact same reason.
 *
 * Requires the full replicated stack from docker-compose, migrated:
 *   docker compose up -d postgres postgres-replica
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
process.env.APP_REPLICA_DATABASE_URL = 'postgresql://hrm_app:hrm_app_dev_password@localhost:5434/hrm_dev?schema=public';

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { appPrisma, appReadReplicaPrisma, prisma, withReplicaTenantContext, withTenantContext } from '../src';

const TENANT_A_SLUG = 'replica-test-tenant-a';
const TENANT_B_SLUG = 'replica-test-tenant-b';

// A direct, OWNER-role (superuser in local dev — see clients.ts) connection
// straight to the REPLICA's own port, used ONLY to call the admin-only
// `pg_wal_replay_pause/resume()` functions Postgres provides for exactly
// this kind of controlled-lag testing. Never used for any tenant-scoped
// query — that's what `withReplicaTenantContext` is for.
const replicaAdmin = new PrismaClient({
  datasourceUrl: 'postgresql://hrm:hrm_dev_password@localhost:5434/hrm_dev?schema=public',
});

let tenantAId: string;
let tenantBId: string;
let branchAId: string;
let branchBId: string;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out waiting for the replica to catch up.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

beforeAll(async () => {
  await resetFixtures();

  const tenantA = await prisma.tenant.create({
    data: { name: 'Replica Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'Replica Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'QA', hostingRegion: 'me-south-1' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const branchA = await prisma.branch.create({
    data: { tenantId: tenantAId, name: 'Replica A Branch', countryCode: 'US', timezone: 'America/New_York' },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenantBId, name: 'Replica B Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
  });
  branchAId = branchA.id;
  branchBId = branchB.id;

  // Let initial replication genuinely catch up before any assertion runs —
  // this is real streaming replication, not instantaneous.
  await waitFor(async () => {
    const row = await withReplicaTenantContext(tenantAId, (tx) => tx.branch.findUnique({ where: { id: branchAId } }));
    return row !== null;
  });
});

afterAll(async () => {
  // Defensive: never leave the replica paused for a later test file.
  await replicaAdmin.$executeRawUnsafe('SELECT pg_wal_replay_resume()').catch(() => undefined);
  await resetFixtures();
  await replicaAdmin.$disconnect();
  await appPrisma.$disconnect();
  await appReadReplicaPrisma.$disconnect();
  await prisma.$disconnect();
});

describe('read replica (Phase 5.1)', () => {
  it('is a genuine second connection, distinct from the primary — proves APP_REPLICA_DATABASE_URL actually took effect', () => {
    expect(appReadReplicaPrisma).not.toBe(appPrisma);
  });

  it('confirms this really is a hot-standby replica, not a second primary', async () => {
    const [{ pg_is_in_recovery: inRecovery }] = await replicaAdmin.$queryRawUnsafe<{ pg_is_in_recovery: boolean }[]>(
      'SELECT pg_is_in_recovery()',
    );
    expect(inRecovery).toBe(true);
  });

  it('RLS holds on the replica exactly as on the primary — tenant A cannot see tenant B via a replica read', async () => {
    const rowsA = await withReplicaTenantContext(tenantAId, (tx) => tx.branch.findMany());
    expect(rowsA.map((r) => r.id)).toEqual([branchAId]);
    expect(rowsA.some((r) => r.id === branchBId)).toBe(false);

    const rowsB = await withReplicaTenantContext(tenantBId, (tx) => tx.branch.findMany());
    expect(rowsB.map((r) => r.id)).toEqual([branchBId]);
    expect(rowsB.some((r) => r.id === branchAId)).toBe(false);
  });

  it('a replica query issued with no tenant context at all still fails loudly (no missing_ok), same as the primary', async () => {
    await expect(appReadReplicaPrisma.branch.findMany()).rejects.toThrow();
  });

  it('the replica genuinely rejects writes at the Postgres engine level (real hot standby, not an app-level convention)', async () => {
    await expect(
      withReplicaTenantContext(tenantAId, (tx) =>
        tx.branch.create({
          data: { tenantId: tenantAId, name: 'Should never persist', countryCode: 'US', timezone: 'America/New_York' },
        }),
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it('read-after-write: a just-written record is read correctly from the PRIMARY even while the replica is deliberately paused and provably lagging', async () => {
    await replicaAdmin.$executeRawUnsafe('SELECT pg_wal_replay_pause()');

    const newBranchName = `Just Written Branch ${randomUUID()}`;
    try {
      const created = await withTenantContext(tenantAId, (tx) =>
        tx.branch.create({ data: { tenantId: tenantAId, name: newBranchName, countryCode: 'US', timezone: 'America/New_York' } }),
      );

      // The primary (read-your-own-write path) sees it immediately.
      const viaPrimary = await withTenantContext(tenantAId, (tx) => tx.branch.findUnique({ where: { id: created.id } }));
      expect(viaPrimary).not.toBeNull();

      // The DELIBERATELY PAUSED replica does NOT see it — proving this is a
      // real, physically separate, actually-lagging connection, not a
      // relabeled primary. This is the exact scenario the docs' "only
      // safely-stale reads go to the replica" rule exists to guard against.
      const viaReplicaWhilePaused = await withReplicaTenantContext(tenantAId, (tx) =>
        tx.branch.findUnique({ where: { id: created.id } }),
      );
      expect(viaReplicaWhilePaused).toBeNull();
    } finally {
      await replicaAdmin.$executeRawUnsafe('SELECT pg_wal_replay_resume()');
    }

    // Once WAL replay resumes, the replica catches up on its own — no
    // application-level intervention needed.
    await waitFor(async () => {
      const row = await withReplicaTenantContext(tenantAId, (tx) => tx.branch.findFirst({ where: { name: newBranchName } }));
      return row !== null;
    });
  });
});
