import { writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { hash } from '@node-rs/argon2';
import { prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';
import { encryptSecret, generateBase32Secret } from './crypto-helpers';
import { FIXTURES_PATH, TEST_PASSWORD, type AdminTestFixtures } from './fixtures';

// Loads apps/api/.env for FIELD_ENCRYPTION_KEY — the SAME key the running
// API server uses, so a TOTP secret encrypted HERE decrypts correctly
// THERE when a spec logs in with it. See crypto-helpers.ts's own doc
// comment for why this suite carries its own tiny copy of the algorithm
// rather than importing apps/api's src (a separate app/process boundary).
loadEnv({ path: `${__dirname}/../../api/.env` });

const ARGON2ID = 2;
const OWNER_EMAIL_PREFIX = 'admin-e2e-owner';
const TENANT_SLUG = 'admin-e2e-tenant';

export default async function globalSetup(): Promise<void> {
  const fieldEncryptionKey = process.env.FIELD_ENCRYPTION_KEY;
  if (!fieldEncryptionKey) {
    throw new Error('FIELD_ENCRYPTION_KEY not found — check apps/api/.env.');
  }

  await prisma.platformAdmin.deleteMany({ where: { email: { startsWith: OWNER_EMAIL_PREFIX } } });
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
  // Specs that create their own tenants through the UI (tenants.spec.ts,
  // rbac-and-country-packs.spec.ts) use a `Date.now()`-suffixed slug for
  // uniqueness WITHIN one run, but a test that fails before reaching its
  // own delete step leaves a real row behind — clean any such leftovers
  // from a PRIOR run too, so `getByRole('link', { name: '<display name>' })`
  // can never accidentally resolve to a stale duplicate.
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: 'admin-e2e-ui-' } } });
  await prisma.countryPack.deleteMany({ where: { countryCode: 'ZZ' } });

  const hashedPassword = await hash(TEST_PASSWORD, { algorithm: ARGON2ID });

  const freshOwnerEmail = `${OWNER_EMAIL_PREFIX}-fresh@hrm-admin-e2e.test`;
  await prisma.platformAdmin.create({
    data: { email: freshOwnerEmail, name: 'Fresh Owner', hashedPassword, role: 'PLATFORM_OWNER' },
  });

  const enrolledOwnerEmail = `${OWNER_EMAIL_PREFIX}-enrolled@hrm-admin-e2e.test`;
  const enrolledOwnerTotpSecret = generateBase32Secret();
  await prisma.platformAdmin.create({
    data: {
      email: enrolledOwnerEmail,
      name: 'Enrolled Owner',
      hashedPassword,
      role: 'PLATFORM_OWNER',
      mfaEnabled: true,
      mfaSecretEncrypted: encryptSecret(enrolledOwnerTotpSecret, fieldEncryptionKey),
    },
  });

  const enrolledSupportEmail = `${OWNER_EMAIL_PREFIX}-support@hrm-admin-e2e.test`;
  const enrolledSupportTotpSecret = generateBase32Secret();
  await prisma.platformAdmin.create({
    data: {
      email: enrolledSupportEmail,
      name: 'Enrolled Support',
      hashedPassword,
      role: 'PLATFORM_SUPPORT',
      mfaEnabled: true,
      mfaSecretEncrypted: encryptSecret(enrolledSupportTotpSecret, fieldEncryptionKey),
    },
  });

  const tenant = await prisma.tenant.create({
    data: { name: 'Admin E2E Tenant', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
  });
  await seedSystemRolesAndPermissions(prisma, tenant.id);
  const role = await prisma.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.TENANT_ADMIN } },
  });
  const seededTenantUserEmail = 'target-user@admin-e2e-tenant.test';
  const tenantUser = await prisma.user.create({
    data: { tenantId: tenant.id, email: seededTenantUserEmail, hashedPassword: 'unused', status: 'ACTIVE' },
  });
  await prisma.userRole.create({ data: { tenantId: tenant.id, userId: tenantUser.id, roleId: role.id } });

  const fixtures: AdminTestFixtures = {
    freshOwnerEmail,
    enrolledOwnerEmail,
    enrolledOwnerTotpSecret,
    enrolledSupportEmail,
    enrolledSupportTotpSecret,
    seededTenantId: tenant.id,
    seededTenantSlug: tenant.slug,
    seededTenantUserId: tenantUser.id,
    seededTenantUserEmail,
  };
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));
}
