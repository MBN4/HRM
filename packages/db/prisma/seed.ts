/**
 * Seeds one demo tenant with two branches in different countries, to prove
 * branch-level country resolution works (a single tenant operating in both
 * the US and Qatar).
 *
 * Runs as the owner/migration role (DATABASE_URL) — seeding is an
 * administrative bootstrap operation, not a tenant-scoped app request, so it
 * intentionally bypasses Row-Level Security rather than going through
 * `withTenantContext`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'acme-demo' },
    update: {},
    create: {
      name: 'Acme Demo Corp',
      slug: 'acme-demo',
      status: 'ACTIVE',
      edition: 'PROFESSIONAL',
      defaultCountryCode: 'US',
      hostingRegion: 'us-east-1',
    },
  });

  const usBranch = await prisma.branch.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Acme US HQ' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Acme US HQ',
      countryCode: 'US',
      timezone: 'America/New_York',
    },
  });

  const qaBranch = await prisma.branch.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Acme Doha Office' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Acme Doha Office',
      countryCode: 'QA',
      timezone: 'Asia/Qatar',
    },
  });

  console.log('Seeded tenant:', { id: tenant.id, slug: tenant.slug });
  console.log('Seeded branches:', [
    { id: usBranch.id, name: usBranch.name, countryCode: usBranch.countryCode },
    { id: qaBranch.id, name: qaBranch.name, countryCode: qaBranch.countryCode },
  ]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
