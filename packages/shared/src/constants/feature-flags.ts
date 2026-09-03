/**
 * The feature-flag catalog and the STATIC edition → flags mapping (step
 * 0.6). See /CLAUDE.md § Conventions → Licensing / feature flags for the
 * full write-up.
 *
 * Unlike `PERMISSIONS`/`SYSTEM_ROLE_PERMISSIONS` (0.4), which are only seed
 * DEFAULTS a tenant can later edit in the DB, `EDITION_FEATURES` here is a
 * pure code constant with no DB-editable counterpart — an edition's flag
 * set is a product/pricing decision, not tenant-editable data. The only
 * per-tenant adjustment mechanism is `TenantFeatureFlagOverride` (a
 * platform-admin lever, not tenant self-service — see
 * `apps/api/src/licensing`), layered on top of whatever this mapping (SaaS
 * mode) or a verified License's `enabledFlags` (lifetime mode) resolves to.
 */
export const FEATURE_FLAGS = {
  ADVANCED_REPORTING: 'advanced_reporting',
  CUSTOM_ROLES: 'custom_roles',
  API_ACCESS: 'api_access',
  SSO: 'sso',
  MULTI_COUNTRY_PAYROLL: 'multi_country_payroll',
  CUSTOM_WORKFLOWS: 'custom_workflows',
  AUDIT_LOG_EXPORT: 'audit_log_export',
  // Step 3.3 — outbound webhook subscriptions gate behind their own flag
  // (PROFESSIONAL+, same tier as API_ACCESS, which already gates the
  // versioned /v1 public API this step builds — reused rather than
  // inventing a second "may integrate programmatically" flag). SSO
  // (already existed since 0.6, ENTERPRISE-only) is what step 3.3's SSO
  // work gates behind — no new flag needed there.
  WEBHOOKS: 'webhooks',
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

export const ALL_FEATURE_FLAGS: readonly FeatureFlagKey[] = Object.values(FEATURE_FLAGS);

export const TENANT_EDITIONS = ['STARTER', 'PROFESSIONAL', 'ENTERPRISE'] as const;
export type TenantEditionKey = (typeof TENANT_EDITIONS)[number];

/**
 * Each edition's flag set is CUMULATIVE by convention (ENTERPRISE ⊇
 * PROFESSIONAL ⊇ STARTER) but that is not enforced structurally — list
 * every flag an edition should have explicitly, don't rely on inheritance,
 * so a deliberate exception (e.g. an ENTERPRISE-only flag pulled from
 * PROFESSIONAL) is a one-line diff, not a structural change.
 */
export const EDITION_FEATURES: Record<TenantEditionKey, readonly FeatureFlagKey[]> = {
  STARTER: [],
  PROFESSIONAL: [
    FEATURE_FLAGS.ADVANCED_REPORTING,
    FEATURE_FLAGS.CUSTOM_ROLES,
    FEATURE_FLAGS.API_ACCESS,
    FEATURE_FLAGS.WEBHOOKS,
  ],
  ENTERPRISE: [
    FEATURE_FLAGS.ADVANCED_REPORTING,
    FEATURE_FLAGS.CUSTOM_ROLES,
    FEATURE_FLAGS.API_ACCESS,
    FEATURE_FLAGS.WEBHOOKS,
    FEATURE_FLAGS.SSO,
    FEATURE_FLAGS.MULTI_COUNTRY_PAYROLL,
    FEATURE_FLAGS.CUSTOM_WORKFLOWS,
    FEATURE_FLAGS.AUDIT_LOG_EXPORT,
  ],
};
