/**
 * Proves `audit_log`'s DB-LEVEL immutability guarantee from the
 * `enable_rls_and_immutability_for_audit_log` migration — not just that no
 * application code path updates/deletes it, but that the `hrm_app` role
 * itself is REVOKEd `UPDATE`/`DELETE` on the table, so even a fully
 * compromised application process cannot alter or erase a written entry.
 * Also proves ordinary tenant isolation (RLS) still applies to `audit_log`
 * exactly like every other tenant-scoped table — see /CLAUDE.md §
 * Conventions → Audit log.
 *
 * Setup/teardown run through `prisma` (the owner role, bypasses RLS and —
 * being the table owner — also bypasses the `REVOKE`, which is what lets
 * teardown clean up rows a real `hrm_app` session could never delete).
 * Every assertion runs through `appPrisma`/`withTenantContext` (the
 * restricted `hrm_app` role both RLS and the immutability REVOKE are
 * enforced against).
 *
 * Requires a local Postgres with all migrations applied:
 *   docker compose up -d postgres
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { prisma, appPrisma, withTenantContext } from '../src';

const TENANT_A_SLUG = 'audit-immutability-tenant-a';
const TENANT_B_SLUG = 'audit-immutability-tenant-b';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

let tenantAId: string;
let tenantBId: string;

beforeAll(async () => {
  await resetFixtures();

  const tenantA = await prisma.tenant.create({
    data: { name: 'Audit Immutability Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'Audit Immutability Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
});

afterAll(async () => {
  await resetFixtures();
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe('audit_log immutability + isolation', () => {
  it('hrm_app CAN insert an audit row', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({
        data: { tenantId: tenantAId, action: 'CREATE', entityType: 'Test', entityId: 'x' },
      }),
    );
    expect(row.id).toBeTruthy();
  });

  it('hrm_app CANNOT update an audit row (revoked at the DB level, not just unused by app code)', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, action: 'CREATE', entityType: 'Test', entityId: 'y' } }),
    );

    await expect(
      withTenantContext(tenantAId, (tx) =>
        tx.auditLog.updateMany({ where: { id: row.id }, data: { action: 'HACKED' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('hrm_app CANNOT delete an audit row', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, action: 'CREATE', entityType: 'Test', entityId: 'z' } }),
    );

    await expect(
      withTenantContext(tenantAId, (tx) => tx.auditLog.deleteMany({ where: { id: row.id } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it('tenant isolation still applies (RLS) — tenant B never sees tenant A\'s audit rows', async () => {
    await withTenantContext(tenantAId, (tx) =>
      tx.auditLog.create({ data: { tenantId: tenantAId, action: 'CREATE', entityType: 'Test', entityId: 'iso' } }),
    );

    const rows = await withTenantContext(tenantBId, (tx) => tx.auditLog.findMany());
    expect(rows).toEqual([]);
  });

  it('fails loudly with no tenant context set, same as every other tenant-scoped table', async () => {
    await expect(appPrisma.auditLog.findMany()).rejects.toThrow();
  });
});
