import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@hrm/db';
import type { PlatformRoleNameKey } from '@hrm/shared';

/**
 * Shared test-only helper for minting a valid platform-admin session
 * directly (bypassing the real login/MFA HTTP flow) — the SAME "mint a
 * token directly, this file's concern is X not auth" shortcut every other
 * e2e file in this suite already takes for tenant JWTs (see e.g.
 * `tenant-resolution.e2e-spec.ts`'s own header comment). The full,
 * REAL login -> MFA-enrollment -> MFA-verify HTTP flow is exercised
 * end-to-end by `platform-auth.e2e-spec.ts` — every other platform e2e
 * file just needs a working, authenticated session to test something
 * unrelated (licensing, rate limits, tenant lifecycle, ...), so it uses
 * this shortcut instead of re-deriving the login flow in every file.
 *
 * Deliberately the ONE shared test helper in this suite (every other e2e
 * file is self-contained by convention) — the alternative was duplicating
 * "create a PlatformAdmin row + sign a matching token with
 * PLATFORM_JWT_SECRET" verbatim across five-plus files, which is
 * boilerplate, not business logic under test.
 */
const platformJwt = new JwtService({ secret: process.env.PLATFORM_JWT_SECRET });

/**
 * Jest gives each e2e FILE its own isolated module registry (a fresh copy
 * of every `import`, even for files run in the same worker), so this
 * array is scoped per test FILE, never shared across them — the reason
 * `cleanupTestPlatformAdmins` (delete-by-EXACT-id) is safe to call from
 * many files' `afterAll`s with no coordination between them. A REAL bug
 * this replaced: the previous version of this helper relied on callers
 * doing `prisma.platformAdmin.deleteMany({ email: { startsWith:
 * 'platform-test-' } })` — harmless under `--runInBand` (one file
 * finishes, including its own cleanup, before the next starts) but a
 * genuine cross-file race under the package's REAL `test` script (plain
 * `jest`, parallel workers): file A's `afterAll` blanket-prefix delete
 * could delete file B's still-in-use fixture rows mid-run, surfacing as
 * spurious 401s on requests using a token whose underlying admin row had
 * just been deleted out from under it. Caught by `pnpm test` (parallel)
 * failing where `pnpm exec jest --runInBand` (sequential) had passed.
 */
const createdAdminIds: string[] = [];

export async function createTestPlatformAdmin(
  role: PlatformRoleNameKey = 'PLATFORM_OWNER',
  overrides: { email?: string; mfaEnabled?: boolean } = {},
): Promise<{ id: string; email: string; role: PlatformRoleNameKey; token: string }> {
  const email = overrides.email ?? `platform-test-${randomUUID()}@hrm-platform.local`;
  const admin = await prisma.platformAdmin.create({
    data: {
      email,
      name: 'Test Platform Admin',
      // Never checked by this shortcut (no HTTP login happens) — a fixed,
      // recognizably-fake hash is enough since PasswordService.verify is
      // never called along this path.
      hashedPassword: 'not-a-real-hash',
      role,
      status: 'ACTIVE',
      mfaEnabled: overrides.mfaEnabled ?? true,
    },
  });
  createdAdminIds.push(admin.id);
  const token = platformJwt.sign({ sub: admin.id, role });
  return { id: admin.id, email: admin.email, role, token };
}

/** Deletes ONLY the admins THIS FILE created via `createTestPlatformAdmin` above — never a prefix scan. Call from `afterAll`. */
export async function cleanupTestPlatformAdmins(): Promise<void> {
  if (createdAdminIds.length === 0) return;
  await prisma.platformAdmin.deleteMany({ where: { id: { in: createdAdminIds } } });
}
