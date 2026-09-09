/**
 * Phase 5.1 (see docs/conventions/scaling-data-layer.md § Connection
 * pooling) — THE #1 RISK of this step: proves PgBouncer, running in
 * TRANSACTION pooling mode in front of Postgres, cannot leak one tenant's
 * `current_tenant` context onto another tenant's request even when many
 * concurrent requests are FORCED to reuse the same small handful of
 * pooled backend connections.
 *
 * This is safe by construction, not by luck: `withTenantContext` sets
 * `app.current_tenant` via `set_config(..., true)` — the parameterized
 * equivalent of `SET LOCAL` — INSIDE a `$transaction(...)` block. Postgres
 * resets a `SET LOCAL`/`set_config(..., true)` value automatically at
 * COMMIT/ROLLBACK, which is EXACTLY when PgBouncer (in transaction mode)
 * returns a backend connection to its pool for the next client to reuse —
 * so there is no window in which a stale tenant setting could still be
 * attached to a connection about to be handed to a different tenant's
 * transaction. This file proves that property directly against a REAL
 * PgBouncer instance, not by re-reading the reasoning above.
 *
 * Requires the full stack from docker-compose, migrated:
 *   docker compose up -d postgres pgbouncer
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { PrismaClient } from '@prisma/client';
import { prisma, withPoolParams, withTenantContext } from '../src';

const TENANT_A_SLUG = 'pgbouncer-test-tenant-a';
const TENANT_B_SLUG = 'pgbouncer-test-tenant-b';

// Deliberately routed through the LOCAL PgBouncer endpoint (docker-compose's
// `pgbouncer` service, transaction pooling mode) rather than Postgres
// directly — see docker-compose.yml. `pgbouncer=true` disables Prisma's own
// prepared-statement caching, the documented, required setting for using
// Prisma against a transaction-mode pooler.
const PGBOUNCER_URL = 'postgresql://hrm_app:hrm_app_dev_password@localhost:6432/hrm_dev?schema=public&pgbouncer=true';

// A DELIBERATELY tiny pool (3 connections) — far smaller than the number of
// concurrent tenant transactions this test fires at it — so connection
// REUSE across different tenants' transactions is not just possible but
// GUARANTEED, the exact scenario that would leak tenant context if
// `current_tenant` were anything other than transaction-local.
const pooledAppPrisma = new PrismaClient({
  datasourceUrl: withPoolParams(PGBOUNCER_URL, { connectionLimit: 3, poolTimeoutSeconds: 10 }),
});

let tenantAId: string;
let tenantBId: string;
let branchAId: string;
let branchBId: string;

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

beforeAll(async () => {
  await resetFixtures();

  const tenantA = await prisma.tenant.create({
    data: { name: 'PgBouncer Test Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'PgBouncer Test Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'QA', hostingRegion: 'me-south-1' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const branchA = await prisma.branch.create({
    data: { tenantId: tenantAId, name: 'PgBouncer A Branch', countryCode: 'US', timezone: 'America/New_York' },
  });
  const branchB = await prisma.branch.create({
    data: { tenantId: tenantBId, name: 'PgBouncer B Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
  });
  branchAId = branchA.id;
  branchBId = branchB.id;
});

afterAll(async () => {
  await resetFixtures();
  await pooledAppPrisma.$disconnect();
  await prisma.$disconnect();
});

describe('PgBouncer (transaction pooling mode) — no cross-tenant leakage under connection reuse', () => {
  it('many concurrent, interleaved-tenant transactions through a 3-connection pool never see the wrong tenant', async () => {
    const ROUNDS = 60;
    const calls = Array.from({ length: ROUNDS }, (_, i) => {
      const isA = i % 2 === 0;
      const tenantId = isA ? tenantAId : tenantBId;
      return withTenantContext(
        tenantId,
        async (tx) => {
          const rows = await tx.branch.findMany();
          return { isA, ids: rows.map((r) => r.id) };
        },
        pooledAppPrisma,
      );
    });

    // Fired concurrently (not sequentially) so the pool is genuinely under
    // contention and connections are genuinely handed between different
    // tenants' transactions mid-run, not just reused serially one at a time.
    const results = await Promise.all(calls);

    for (const { isA, ids } of results) {
      expect(ids).toEqual(isA ? [branchAId] : [branchBId]);
    }
  });

  it('a query issued through the pooler with NO tenant context set still fails loudly (no missing_ok)', async () => {
    await expect(pooledAppPrisma.branch.findMany()).rejects.toThrow();
  });

  it('a crafted WHERE clause naming the other tenant still returns nothing through the pooler — RLS, not the query, governs', async () => {
    const rows = await withTenantContext(
      tenantAId,
      (tx) => tx.branch.findMany({ where: { tenantId: tenantBId } }),
      pooledAppPrisma,
    );
    expect(rows).toEqual([]);
  });
});
