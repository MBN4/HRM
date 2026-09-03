import { z } from 'zod';
import { TENANT_EDITIONS } from '../constants/feature-flags';
import { PLATFORM_ROLE_NAMES } from '../constants/platform-permissions';
import { countryPackConfigSchema } from './country-pack.validator';

/**
 * Platform (vendor super-admin) request DTOs — step 4.1. See
 * docs/conventions/vendor-console.md. Mirrors this codebase's existing
 * "JSON has no schema-level guarantee of its own, validate on every write"
 * posture wherever a JSON column is involved (country pack config).
 */

// --- Platform auth / MFA -----------------------------------------------

export const platformLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type PlatformLoginInput = z.infer<typeof platformLoginRequestSchema>;

export const platformMfaEnrollConfirmRequestSchema = z.object({
  enrollmentToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'code must be a 6-digit TOTP code'),
});
export type PlatformMfaEnrollConfirmInput = z.infer<typeof platformMfaEnrollConfirmRequestSchema>;

export const platformMfaVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1),
  /** Either a 6-digit TOTP code or a one-time recovery code. */
  code: z.string().min(6),
});
export type PlatformMfaVerifyInput = z.infer<typeof platformMfaVerifyRequestSchema>;

export const platformRefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type PlatformRefreshInput = z.infer<typeof platformRefreshRequestSchema>;

export const platformEnrollmentTokenRequestSchema = z.object({
  enrollmentToken: z.string().min(1),
});
export type PlatformEnrollmentTokenInput = z.infer<typeof platformEnrollmentTokenRequestSchema>;

// --- Platform admin accounts --------------------------------------------

export const createPlatformAdminRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12, 'Platform admin passwords must be at least 12 characters.'),
  role: z.enum(PLATFORM_ROLE_NAMES),
});
export type CreatePlatformAdminInput = z.infer<typeof createPlatformAdminRequestSchema>;

export const updatePlatformAdminRequestSchema = z
  .object({
    role: z.enum(PLATFORM_ROLE_NAMES),
    status: z.enum(['ACTIVE', 'SUSPENDED']),
  })
  .partial()
  .refine((v) => v.role !== undefined || v.status !== undefined, 'At least one field must be provided.');
export type UpdatePlatformAdminInput = z.infer<typeof updatePlatformAdminRequestSchema>;

// --- Tenant lifecycle -----------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const platformCreateTenantRequestSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().regex(SLUG_PATTERN, 'slug must be lowercase alphanumeric with optional hyphens'),
    defaultCountryCode: z.string().length(2),
    hostingRegion: z.string().min(1),
    edition: z.enum(TENANT_EDITIONS).optional(),
    provisionMode: z.enum(['SHARED_DB', 'DB_PER_TENANT']).optional(),
    baseCurrencyCode: z.string().length(3).optional(),
    /** All three or none — the tenant's first TENANT_ADMIN, created in the same operation as a convenience. Omit to provision the tenant (RBAC seeded, no users) for a separate onboarding step to populate later. */
    initialAdminEmail: z.string().email().optional(),
    initialAdminName: z.string().min(1).optional(),
    initialAdminPassword: z.string().min(12).optional(),
  })
  .refine((v) => {
    const provided = [v.initialAdminEmail, v.initialAdminName, v.initialAdminPassword];
    const count = provided.filter((x) => x !== undefined).length;
    return count === 0 || count === 3;
  }, 'initialAdminEmail, initialAdminName, and initialAdminPassword must all be provided together, or all omitted.');
export type PlatformCreateTenantInput = z.infer<typeof platformCreateTenantRequestSchema>;

export const platformUpdateTenantRequestSchema = z
  .object({
    edition: z.enum(TENANT_EDITIONS),
    hostingRegion: z.string().min(1),
    provisionMode: z.enum(['SHARED_DB', 'DB_PER_TENANT']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided.');
export type PlatformUpdateTenantInput = z.infer<typeof platformUpdateTenantRequestSchema>;

export const suspendTenantRequestSchema = z.object({
  reason: z.string().min(1).optional(),
});
export type SuspendTenantInput = z.infer<typeof suspendTenantRequestSchema>;

/**
 * `confirmSlug` must exactly match the tenant's own slug — the
 * type-to-confirm pattern for an irreversible, cross-cutting-cascade
 * delete, the same "measure twice" posture this codebase already applies
 * to every genuinely destructive action.
 */
export const deleteTenantRequestSchema = z.object({
  confirmSlug: z.string().min(1),
});
export type DeleteTenantInput = z.infer<typeof deleteTenantRequestSchema>;

// --- Country pack authoring ------------------------------------------------

export const createCountryPackRequestSchema = z.object({
  countryCode: z.string().length(2),
  config: countryPackConfigSchema,
});
export type CreateCountryPackInput = z.infer<typeof createCountryPackRequestSchema>;

export const createCountryPackVersionRequestSchema = z.object({
  /** Omit to start the new draft version as a copy of the currently active version's config. */
  config: countryPackConfigSchema.optional(),
});
export type CreateCountryPackVersionInput = z.infer<typeof createCountryPackVersionRequestSchema>;

export const updateCountryPackVersionRequestSchema = z.object({
  config: countryPackConfigSchema,
});
export type UpdateCountryPackVersionInput = z.infer<typeof updateCountryPackVersionRequestSchema>;

// --- Impersonation -----------------------------------------------------

export const startImpersonationRequestSchema = z.object({
  targetUserId: z.string().uuid(),
  reason: z.string().min(3, 'A reason is required for every impersonation session.'),
  /** Capped server-side (see PlatformImpersonationService) regardless of what's requested here. */
  durationMinutes: z.number().int().positive().max(120).optional(),
});
export type StartImpersonationInput = z.infer<typeof startImpersonationRequestSchema>;

// --- Cross-tenant audit query -----------------------------------------------

export const platformAuditQuerySchema = z.object({
  targetTenantId: z.string().uuid().optional(),
  platformAdminId: z.string().uuid().optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  /** ISO timestamp cursor — entries strictly before this. */
  before: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type PlatformAuditQueryInput = z.infer<typeof platformAuditQuerySchema>;
