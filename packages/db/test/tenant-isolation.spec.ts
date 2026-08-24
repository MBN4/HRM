/**
 * Proves the Row-Level Security policy from the `enable_row_level_security`
 * migration actually isolates tenants — not just that the schema/FKs look
 * right. Setup/teardown run through `prisma` (the owner role, which
 * bypasses RLS by design); every assertion runs through `appPrisma` (the
 * restricted `hrm_app` role RLS is enforced against) via `withTenantContext`.
 *
 * Requires a local Postgres with both migrations applied:
 *   docker compose up -d postgres
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { randomUUID } from 'node:crypto';
import { prisma, appPrisma, withTenantContext } from '../src';

const TENANT_A_SLUG = 'rls-test-tenant-a';
const TENANT_B_SLUG = 'rls-test-tenant-b';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

let tenantAId: string;
let tenantBId: string;
let branchAId: string;
let branchBId: string;

beforeAll(async () => {
  await resetFixtures();

  const tenantA = await prisma.tenant.create({
    data: {
      name: 'RLS Test Tenant A',
      slug: TENANT_A_SLUG,
      defaultCountryCode: 'US',
      hostingRegion: 'us-east-1',
    },
  });
  const tenantB = await prisma.tenant.create({
    data: {
      name: 'RLS Test Tenant B',
      slug: TENANT_B_SLUG,
      defaultCountryCode: 'QA',
      hostingRegion: 'me-south-1',
    },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const branchA = await prisma.branch.create({
    data: {
      tenantId: tenantAId,
      name: 'Tenant A Branch',
      countryCode: 'US',
      timezone: 'America/New_York',
    },
  });
  const branchB = await prisma.branch.create({
    data: {
      tenantId: tenantBId,
      name: 'Tenant B Branch',
      countryCode: 'QA',
      timezone: 'Asia/Qatar',
    },
  });
  branchAId = branchA.id;
  branchBId = branchB.id;
});

afterAll(async () => {
  await resetFixtures();
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe('tenant isolation (Row-Level Security)', () => {
  it('returns only the current tenant\'s rows with no where clause', async () => {
    const rows = await withTenantContext(tenantAId, (tx) => tx.branch.findMany());

    expect(rows.map((r) => r.id)).toEqual([branchAId]);
    expect(rows.some((r) => r.id === branchBId)).toBe(false);
  });

  it('CANNOT read another tenant\'s rows via a crafted where clause', async () => {
    // Attacker-controlled code, running under tenant A's context, tries to
    // force tenantId = B into the where clause hoping to read B's data.
    const rows = await withTenantContext(tenantAId, (tx) =>
      tx.branch.findMany({ where: { tenantId: tenantBId } }),
    );

    expect(rows).toEqual([]);
  });

  it('CANNOT read another tenant\'s row by primary key alone', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.branch.findUnique({ where: { id: branchBId } }),
    );

    expect(row).toBeNull();
  });

  it('enforces isolation below the ORM layer (raw SQL) too', async () => {
    const rows = await withTenantContext(
      tenantAId,
      (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM branches`,
    );

    expect(rows.map((r) => r.id)).toEqual([branchAId]);
  });

  it('switching context to tenant B sees only tenant B\'s rows', async () => {
    const rows = await withTenantContext(tenantBId, (tx) => tx.branch.findMany());

    expect(rows.map((r) => r.id)).toEqual([branchBId]);
  });

  it('CANNOT write a row tagged as another tenant (WITH CHECK)', async () => {
    await expect(
      withTenantContext(tenantAId, (tx) =>
        tx.branch.create({
          data: {
            tenantId: tenantBId,
            name: 'Smuggled Branch',
            countryCode: 'US',
            timezone: 'America/New_York',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('fails loudly (does not silently return data) when no tenant context is set', async () => {
    // Bypasses withTenantContext entirely: no set_config call happens, so
    // the RLS policy's current_setting() call has nothing to read.
    await expect(appPrisma.branch.findMany()).rejects.toThrow();
  });

  it('rejects a non-UUID tenant id before ever reaching Postgres', async () => {
    await expect(
      withTenantContext('not-a-uuid', (tx) => tx.branch.findMany()),
    ).rejects.toThrow(/not a UUID/);
  });

  it('rejects an unknown-but-valid-looking tenant id (no data, not an error)', async () => {
    const rows = await withTenantContext(randomUUID(), (tx) => tx.branch.findMany());
    expect(rows).toEqual([]);
  });
});
