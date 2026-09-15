/**
 * Phase 5.4 — provisions a REALISTIC multi-tenant fixture for the k6
 * scenarios in `load/scenarios/`: a mix of tenant SIZES (a couple of
 * "whale" tenants with hundreds of employees, many "typical" small ones),
 * not one giant tenant — the shape this step's own brief explicitly asks
 * for ("model realistic tenant + user distribution"). Writes a manifest
 * (`load/fixtures/tenants.json`) the k6 scripts read via `open()` so they
 * never hardcode a tenant id/slug/password.
 *
 * Run: `pnpm --filter @hrm/api run seed:load-test` (see package.json).
 * Idempotent by tenant SLUG prefix: re-running first deletes any
 * previously-seeded `loadtest-*` tenants, so this is safe to run
 * repeatedly against the same local database.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { prisma, seedSystemRolesAndPermissions, SYSTEM_ROLES } from '@hrm/db';

const ARGON2ID = 2;
const LOAD_TEST_PASSWORD = 'LoadTest!2026';
const SLUG_PREFIX = 'loadtest';

interface TenantSpec {
  slug: string;
  name: string;
  employeeCount: number;
  countryCode: 'US' | 'QA' | 'PK';
}

// 2 "whale" tenants (the ones a noisy-neighbor / rate-limit-isolation
// scenario deliberately hammers) + 8 ordinary-sized ones — a genuinely
// skewed distribution, not N identical tenants.
const TENANT_SPECS: TenantSpec[] = [
  { slug: `${SLUG_PREFIX}-whale-1`, name: 'LoadTest Whale Co 1', employeeCount: 300, countryCode: 'US' },
  { slug: `${SLUG_PREFIX}-whale-2`, name: 'LoadTest Whale Co 2', employeeCount: 200, countryCode: 'QA' },
  ...Array.from({ length: 8 }, (_, i) => ({
    slug: `${SLUG_PREFIX}-small-${i + 1}`,
    name: `LoadTest Small Co ${i + 1}`,
    employeeCount: 15,
    countryCode: (['US', 'QA', 'PK'] as const)[i % 3],
  })),
];

/**
 * How many of a tenant's OWN employee logins to include in the manifest.
 * MUST be large enough that `attendance-clockin.js`'s VU count never
 * exceeds the total number of DISTINCT (tenant, employee) identities
 * across all tenants — a REAL bug this step's own k6 run caught: with
 * only 10/tenant (100 total identities) against 200 VUs, `__VU %
 * assignments.length` wrapped around and put TWO DIFFERENT VUs behind the
 * SAME employee identity, so they raced each other's clock-in/out calls
 * (one call's "already clocked in" 400 looks identical to a real bug
 * unless you notice the identity collision first) — see
 * docs/conventions/observability-load.md § Load testing findings. At 100
 * (capped per-tenant by that tenant's own `employeeCount` — the 8 small
 * 15-employee tenants still only contribute 15 each), the two 300/200-
 * employee whale tenants alone already contribute 200 identities,
 * comfortably above the 200-VU ceiling `attendance-clockin.js` ramps to.
 */
const SAMPLE_EMPLOYEE_LOGINS_PER_TENANT = 100;

interface TenantFixture {
  tenantId: string;
  slug: string;
  employeeCount: number;
  loginEmail: string;
  password: string;
  branchId: string;
  /** A sample of real employee (not manager) logins — see `SAMPLE_EMPLOYEE_LOGINS_PER_TENANT`. */
  employeeLogins: string[];
  /** `ENTERPRISE` (only the "whale" tenants) is required for `MULTI_COUNTRY_PAYROLL` — the payroll k6 scenario filters on this. */
  edition: 'PROFESSIONAL' | 'ENTERPRISE';
}

async function main() {
  console.log(`Purging any previously-seeded ${SLUG_PREFIX}-* tenants...`);
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: `${SLUG_PREFIX}-` } } });

  const passwordHash = await hash(LOAD_TEST_PASSWORD, { algorithm: ARGON2ID });
  const fixtures: TenantFixture[] = [];

  for (const spec of TENANT_SPECS) {
    const edition: 'PROFESSIONAL' | 'ENTERPRISE' = spec.employeeCount > 100 ? 'ENTERPRISE' : 'PROFESSIONAL';
    const tenant = await prisma.tenant.create({
      data: {
        name: spec.name,
        slug: spec.slug,
        defaultCountryCode: spec.countryCode,
        hostingRegion: 'us-east-1',
        edition,
      },
    });

    if (edition === 'ENTERPRISE') {
      // The payroll k6 scenario needs MULTI_COUNTRY_PAYROLL, an
      // ENTERPRISE-only feature — in SaaS mode (this repo's default,
      // LICENSE_MODE=saas) entitlement resolves from a real, ACTIVE
      // `Subscription` row, not `Tenant.edition` alone. See
      // docs/conventions/licensing-feature-flags.md.
      await prisma.subscription.create({ data: { tenantId: tenant.id, edition, status: 'ACTIVE' } });
    }

    await seedSystemRolesAndPermissions(prisma, tenant.id);
    const employeeRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.EMPLOYEE } },
    });
    const hrManagerRole = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenant.id, name: SYSTEM_ROLES.HR_MANAGER } },
    });

    const branch = await prisma.branch.create({
      data: { tenantId: tenant.id, name: 'HQ', countryCode: spec.countryCode, timezone: 'UTC' },
    });

    // One HR_MANAGER user is the login/dashboard/list-endpoint actor for
    // this tenant's k6 VUs — real permission set, not a superuser shortcut.
    const loginEmail = `loadtest-manager@${spec.slug}.test`;
    const manager = await prisma.user.create({
      data: { tenantId: tenant.id, email: loginEmail, hashedPassword: passwordHash, status: 'ACTIVE' },
    });
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: manager.id, roleId: hrManagerRole.id } });
    await prisma.userBranch.create({ data: { tenantId: tenant.id, userId: manager.id, branchId: branch.id } });

    const employeeLogins: string[] = [];
    for (let i = 0; i < spec.employeeCount; i += 1) {
      const empEmail = `loadtest-emp-${i}@${spec.slug}.test`;
      const empUser = await prisma.user.create({
        data: { tenantId: tenant.id, email: empEmail, hashedPassword: passwordHash, status: 'ACTIVE' },
      });
      await prisma.userRole.create({ data: { tenantId: tenant.id, userId: empUser.id, roleId: employeeRole.id } });
      await prisma.employee.create({
        data: {
          tenantId: tenant.id,
          userId: empUser.id,
          branchId: branch.id,
          employeeCode: `${spec.slug}-E${i}`,
          firstName: 'Load',
          lastName: `Test${i}`,
          status: 'ACTIVE',
          employmentType: 'FULL_TIME',
          joinDate: new Date('2024-01-01'),
        },
      });
      if (i < SAMPLE_EMPLOYEE_LOGINS_PER_TENANT) {
        employeeLogins.push(empEmail);
      }
    }

    console.log(`Seeded ${spec.slug}: ${spec.employeeCount} employees.`);
    fixtures.push({
      tenantId: tenant.id,
      slug: spec.slug,
      employeeCount: spec.employeeCount,
      loginEmail,
      password: LOAD_TEST_PASSWORD,
      branchId: branch.id,
      employeeLogins,
      edition,
    });
  }

  const manifestPath = join(__dirname, '../../../load/fixtures/tenants.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ tenants: fixtures }, null, 2));
  console.log(`Wrote manifest: ${manifestPath}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
