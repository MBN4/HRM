import type { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';

const ARGON2ID = 2;

/**
 * Seeds ONE bootstrap PLATFORM_OWNER admin for local dev/demo — every
 * environment needs at least one platform admin to ever reach the vendor
 * console at all (there is no other way to create the first one). Mirrors
 * `PasswordService`'s exact algorithm/parameters (see
 * apps/api/src/auth/password.service.ts) so the seeded password verifies
 * correctly through the real login flow.
 *
 * Deliberately `mfaEnabled: false` — even the bootstrap admin must
 * complete real MFA enrollment on first login (`POST /platform/auth/login`
 * -> `mfaSetupRequired: true`), the same mandatory-MFA path every other
 * admin goes through. There is no seeded bypass of that.
 *
 * `email`/`password` are LOCAL-DEV DEFAULTS, the same posture this repo
 * already takes for `hrm_app`'s seeded DB password (see
 * docs/conventions/tenancy-rls.md) — any non-local environment must not
 * rely on this seed for its real platform admin account.
 */
export async function seedPlatformAdmin(prisma: PrismaClient): Promise<{ email: string; password: string }> {
  const email = 'owner@hrm-platform.local';
  const password = 'ChangeMe-Platform-Owner-123!';
  const hashedPassword = await hash(password, { algorithm: ARGON2ID });

  await prisma.platformAdmin.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Platform Owner', hashedPassword, role: 'PLATFORM_OWNER' },
  });

  return { email, password };
}
