/**
 * Integration test (real Postgres, no HTTP/Nest bootstrap needed — this
 * service has no injected dependencies) for the RTL-specific half of
 * recipient locale resolution that the e2e suite's rendered-body
 * assertions don't directly exercise: `rtl` itself, and the
 * `User.preferredLanguage` override changing BOTH language and its
 * derived `rtl` independently of the recipient's branch.
 */
import { prisma, seedCountryPacks, withTenantContext } from '@hrm/db';
import { NotificationLocaleResolverService } from './notification-locale-resolver.service';

const TENANT_SLUG = 'notif-locale-resolver-test';

async function resetFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: TENANT_SLUG } });
}

describe('NotificationLocaleResolverService', () => {
  const resolver = new NotificationLocaleResolverService();
  let tenantId: string;
  let usUserId: string;
  let qaUserId: string;
  let preferredArabicUsUserId: string;

  beforeAll(async () => {
    await resetFixtures();
    await seedCountryPacks(prisma);

    const tenant = await prisma.tenant.create({
      data: { name: 'Notif Locale Resolver Test', slug: TENANT_SLUG, defaultCountryCode: 'US', hostingRegion: 'us-east-1' },
    });
    tenantId = tenant.id;

    const usBranch = await prisma.branch.create({
      data: { tenantId, name: 'Locale US Branch', countryCode: 'US', timezone: 'America/New_York' },
    });
    const qaBranch = await prisma.branch.create({
      data: { tenantId, name: 'Locale QA Branch', countryCode: 'QA', timezone: 'Asia/Qatar' },
    });

    const usUser = await prisma.user.create({
      data: { tenantId, email: 'us@locale-resolver.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    usUserId = usUser.id;
    await prisma.userBranch.create({ data: { tenantId, userId: usUser.id, branchId: usBranch.id } });

    const qaUser = await prisma.user.create({
      data: { tenantId, email: 'qa@locale-resolver.test', hashedPassword: 'unused', status: 'ACTIVE' },
    });
    qaUserId = qaUser.id;
    await prisma.userBranch.create({ data: { tenantId, userId: qaUser.id, branchId: qaBranch.id } });

    const preferredArabicUsUser = await prisma.user.create({
      data: {
        tenantId,
        email: 'us-prefers-arabic@locale-resolver.test',
        hashedPassword: 'unused',
        status: 'ACTIVE',
        preferredLanguage: 'ar',
      },
    });
    preferredArabicUsUserId = preferredArabicUsUser.id;
    await prisma.userBranch.create({ data: { tenantId, userId: preferredArabicUsUser.id, branchId: usBranch.id } });
  });

  afterAll(async () => {
    await resetFixtures();
    await prisma.$disconnect();
  });

  it("resolves a US-branch recipient's locale to English, LTR", async () => {
    const locale = await withTenantContext(tenantId, (tx) => resolver.resolveRecipientLocale(tx, tenantId, usUserId));
    expect(locale).toEqual({ language: 'en', rtl: false });
  });

  it("resolves a Qatar-branch recipient's locale to Arabic, RTL", async () => {
    const locale = await withTenantContext(tenantId, (tx) => resolver.resolveRecipientLocale(tx, tenantId, qaUserId));
    expect(locale).toEqual({ language: 'ar', rtl: true });
  });

  it('a per-user preferredLanguage override wins over the branch/country-pack default, deriving RTL independently', async () => {
    const locale = await withTenantContext(tenantId, (tx) =>
      resolver.resolveRecipientLocale(tx, tenantId, preferredArabicUsUserId),
    );
    // US branch (pack default: en/LTR), but the user prefers Arabic —
    // language AND rtl should both follow the preference, not the branch.
    expect(locale).toEqual({ language: 'ar', rtl: true });
  });
});
