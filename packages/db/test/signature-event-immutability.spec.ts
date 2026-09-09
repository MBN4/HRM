/**
 * Proves `signature_events`' DB-LEVEL immutability guarantee from the
 * `enable_rls_for_esignature_module` migration — the SAME mechanism
 * `audit-log-immutability.spec.ts` already proves for `audit_log` (REVOKE
 * UPDATE/DELETE from `hrm_app`, on top of ordinary RLS) — applied here to
 * the e-signature module's own evidentiary trail. See
 * docs/conventions/e-signatures.md.
 *
 * Requires a local Postgres with all migrations applied:
 *   docker compose up -d postgres
 *   pnpm --filter @hrm/db exec prisma migrate deploy
 */
import { prisma, appPrisma, withTenantContext } from '../src';

const TENANT_A_SLUG = 'esig-immutability-tenant-a';
const TENANT_B_SLUG = 'esig-immutability-tenant-b';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
}

let tenantAId: string;
let tenantBId: string;
let requestAId: string;

beforeAll(async () => {
  await resetFixtures();

  const tenantA = await prisma.tenant.create({
    data: { name: 'E-Signature Immutability Tenant A', slug: TENANT_A_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: 'E-Signature Immutability Tenant B', slug: TENANT_B_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const user = await prisma.user.create({ data: { tenantId: tenantAId, email: 'creator@esig-immutability-a.test', hashedPassword: 'unused', status: 'ACTIVE' } });
  const requestA = await prisma.signatureRequest.create({
    data: {
      tenantId: tenantAId,
      title: 'Fixture document',
      documentSource: 'UPLOADED',
      documentStorageKey: 'fixture/key',
      documentHash: 'deadbeef',
      createdByUserId: user.id,
    },
  });
  requestAId = requestA.id;
});

afterAll(async () => {
  await resetFixtures();
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe('signature_events immutability + isolation', () => {
  it('hrm_app CAN insert a signature event', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.signatureEvent.create({ data: { tenantId: tenantAId, signatureRequestId: requestAId, eventType: 'CREATED' } }),
    );
    expect(row.id).toBeTruthy();
  });

  it('hrm_app CANNOT update a signature event (revoked at the DB level, not just unused by app code)', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.signatureEvent.create({ data: { tenantId: tenantAId, signatureRequestId: requestAId, eventType: 'SENT' } }),
    );

    await expect(
      withTenantContext(tenantAId, (tx) => tx.signatureEvent.updateMany({ where: { id: row.id }, data: { eventType: 'SIGNED' } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it('hrm_app CANNOT delete a signature event', async () => {
    const row = await withTenantContext(tenantAId, (tx) =>
      tx.signatureEvent.create({ data: { tenantId: tenantAId, signatureRequestId: requestAId, eventType: 'VIEWED' } }),
    );

    await expect(withTenantContext(tenantAId, (tx) => tx.signatureEvent.deleteMany({ where: { id: row.id } }))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("tenant isolation still applies (RLS) — tenant B never sees tenant A's signature events", async () => {
    await withTenantContext(tenantAId, (tx) =>
      tx.signatureEvent.create({ data: { tenantId: tenantAId, signatureRequestId: requestAId, eventType: 'DECLINED' } }),
    );

    const rows = await withTenantContext(tenantBId, (tx) => tx.signatureEvent.findMany());
    expect(rows).toEqual([]);
  });

  it('fails loudly with no tenant context set, same as every other tenant-scoped table', async () => {
    await expect(appPrisma.signatureEvent.findMany()).rejects.toThrow();
  });
});
