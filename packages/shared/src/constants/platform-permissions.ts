/**
 * The platform (vendor super-admin) permission catalog and role -> permission
 * mapping — step 4.1. See docs/conventions/vendor-console.md.
 *
 * UNLIKE `PERMISSIONS`/`SYSTEM_ROLE_PERMISSIONS` (tenant RBAC, 0.4), this is
 * a PURE CODE CONSTANT with no DB-editable counterpart — the same posture
 * `EDITION_FEATURES` documents for itself: the vendor's own operations-staff
 * role model is a fixed, reviewed, two-role set (least-privilege by design),
 * not tenant-customizable data. `PlatformAdmin.role` (a Postgres enum, see
 * schema.prisma) is checked against THIS table at request time by
 * `PlatformPermissionsGuard` — there is no DB table a platform admin could
 * edit to grant themselves more.
 */
export const PLATFORM_PERMISSIONS = {
  /** List/read tenants, their subscription/license, and usage metrics. */
  TENANT_READ: 'platform.tenant.read',
  /** Create a tenant; suspend/resume; change edition, hosting region, provision mode. */
  TENANT_MANAGE: 'platform.tenant.manage',
  /** Hard-delete a tenant and all its data — separate from TENANT_MANAGE, deliberately the most tightly held permission in the catalog. */
  TENANT_DELETE: 'platform.tenant.delete',
  /** Issue/revoke lifetime license files, toggle per-tenant feature-flag overrides — gates the EXISTING (0.6) LicensingAdminController routes too. */
  LICENSE_MANAGE: 'platform.license.manage',
  /** Author/version/activate Country Packs. */
  COUNTRY_PACK_MANAGE: 'platform.country_pack.manage',
  /** Read per-tenant usage metrics (seats, storage, API volume) and the platform-wide health overview. */
  USAGE_READ: 'platform.usage.read',
  /** Read the cross-tenant audit trail (this platform's own PlatformAuditLog, and any tenant's audit_log). */
  AUDIT_READ: 'platform.audit.read',
  /** Start (and end) a support impersonation session against a tenant user. */
  IMPERSONATION_START: 'platform.impersonation.start',
  /** Create/suspend/change-role of OTHER platform admin accounts — deliberately separate from every other permission, PLATFORM_OWNER only. */
  ADMIN_MANAGE: 'platform.admin.manage',
  /** Gates the EXISTING (0.10) RateLimitAdminController per-tenant rate-limit override routes. */
  RATE_LIMIT_MANAGE: 'platform.rate_limit.manage',
  /** Step 4.2 — read any tenant's subscription/invoice/payment-method state and the cross-tenant billing overview. Support-safe (read-only). */
  BILLING_READ: 'platform.billing.read',
  /** Step 4.2 — trigger an AMC invoice, force-resync a tenant's Stripe state, or otherwise mutate billing on a tenant's behalf. A real-money control point, deliberately OWNER-only, the same "most tightly held" posture TENANT_DELETE/ADMIN_MANAGE already document. */
  BILLING_MANAGE: 'platform.billing.manage',
  /** Step 4.3 — read any tenant's branding/custom-domain/rebrand state and the cross-tenant branding overview. Support-safe (read-only), the same "READ is broad, MANAGE is narrow" split BILLING_READ/BILLING_MANAGE already establish. */
  BRANDING_READ: 'platform.branding.read',
  /** Step 4.3 — verify/approve a tenant's custom domain, provision TLS for it, or force-reset a tenant's branding to defaults. OWNER-only, same posture as BILLING_MANAGE. */
  BRANDING_MANAGE: 'platform.branding.manage',
} as const;

export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

export const ALL_PLATFORM_PERMISSIONS: readonly PlatformPermissionKey[] = Object.values(PLATFORM_PERMISSIONS);

export const PLATFORM_ROLE_NAMES = ['PLATFORM_OWNER', 'PLATFORM_SUPPORT'] as const;
export type PlatformRoleNameKey = (typeof PLATFORM_ROLE_NAMES)[number];

/**
 * Least-privilege: PLATFORM_SUPPORT can read tenants/usage/audit and start
 * an impersonation session for support/debugging purposes, but cannot
 * create/suspend/delete a tenant, issue a license, author a country pack,
 * touch rate-limit overrides, or manage other platform admin accounts.
 * PLATFORM_OWNER holds every permission in the catalog.
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRoleNameKey, readonly PlatformPermissionKey[]> = {
  PLATFORM_OWNER: ALL_PLATFORM_PERMISSIONS,
  PLATFORM_SUPPORT: [
    PLATFORM_PERMISSIONS.TENANT_READ,
    PLATFORM_PERMISSIONS.USAGE_READ,
    PLATFORM_PERMISSIONS.AUDIT_READ,
    PLATFORM_PERMISSIONS.IMPERSONATION_START,
    PLATFORM_PERMISSIONS.BILLING_READ,
    PLATFORM_PERMISSIONS.BRANDING_READ,
  ],
};
