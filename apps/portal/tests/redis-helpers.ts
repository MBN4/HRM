import Redis from 'ioredis';

/**
 * Test-only helper that reads the real password-reset token straight out of
 * Redis — the SAME store `AuthService.requestPasswordReset`
 * (apps/api/src/auth/auth.service.ts) writes to via its `resetKey(token)`
 * helper (`auth:pwreset:<token>`, value `{tenantId, userId}`, 30-min TTL).
 *
 * This mirrors what a human developer does locally per
 * docs/conventions/frontend-ess-mss.md → "Forgot / reset password": the
 * 0.8 dev/log notification provider prints the SAME token to the API
 * console (`[DEV EMAIL] ... Use this code to continue: <token>`) since no
 * real email is wired up locally. Playwright's `webServer` runs with
 * `reuseExistingServer: true` against a possibly-already-running API
 * process, so there's no reliable stdout stream for a test to scrape —
 * reading the token directly out of the same Redis instance the API
 * itself uses is the reliable equivalent.
 */
export async function getPasswordResetToken(userId: string, timeoutMs = 10_000): Promise<string> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const keys = await redis.keys('auth:pwreset:*');
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { tenantId: string; userId: string };
        if (parsed.userId === userId) {
          return key.slice('auth:pwreset:'.length);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`getPasswordResetToken: no reset token appeared for user=${userId} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    redis.disconnect();
  }
}
