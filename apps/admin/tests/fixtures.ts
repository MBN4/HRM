export const TEST_PASSWORD = 'AdminTestPassword123!';

export interface AdminTestFixtures {
  /** A brand-new admin with NO MFA yet — auth.spec.ts drives the real enrollment UI with this one. */
  freshOwnerEmail: string;
  /** Already MFA-enrolled (fixture-seeded, see global-setup.ts) — every other spec logs in with this one to skip re-driving enrollment every time. */
  enrolledOwnerEmail: string;
  enrolledOwnerTotpSecret: string;
  enrolledSupportEmail: string;
  enrolledSupportTotpSecret: string;
  seededTenantId: string;
  seededTenantSlug: string;
  seededTenantUserId: string;
  seededTenantUserEmail: string;
}

export const FIXTURES_PATH = `${__dirname}/.fixtures.json`;
