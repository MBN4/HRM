import { z } from 'zod';
import { ALL_FEATURE_FLAGS, TENANT_EDITIONS } from '../constants/feature-flags';

/**
 * The custom claims a signed license file (a JWT-shaped, RS256-signed
 * token) carries, on top of the standard `iat`/`exp` claims `jsonwebtoken`
 * manages itself. See /CLAUDE.md § Conventions → Licensing / feature flags
 * → Lifetime mode for the full format and the key-handling rule (the
 * PRIVATE signing key never ships in an on-prem build — only the public
 * key, used to verify this shape, does).
 *
 * `exp` is intentionally NOT part of this schema: a perpetual license is
 * one signed with no `expiresIn`, so `jsonwebtoken` never adds an `exp`
 * claim at all — its absence is the "no expiry" state, not a sentinel
 * value here.
 */
export const licensePayloadSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string().min(1),
  edition: z.enum(TENANT_EDITIONS),
  enabledFlags: z.array(z.enum(ALL_FEATURE_FLAGS as unknown as [string, ...string[]])),
  seatCap: z.number().int().positive(),
  /**
   * Present only for a license issued as part of the offline
   * challenge-response activation flow — binds this specific signed file
   * to the specific activation request it answers, so it can't be
   * replayed against a different install's pending challenge. Absent for
   * a directly-issued (online) license.
   */
  challenge: z.string().min(1).optional(),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

export const issueLicenseRequestSchema = z.object({
  tenantId: z.string().uuid(),
  edition: z.enum(TENANT_EDITIONS),
  enabledFlags: z.array(z.enum(ALL_FEATURE_FLAGS as unknown as [string, ...string[]])),
  seatCap: z.number().int().positive(),
  /** Omit for a perpetual license. */
  expiresInDays: z.number().int().positive().optional(),
  /** The nonce from a prior `POST /licensing/activation/challenge` call, for the offline flow. Omit for direct/online issuance. */
  challenge: z.string().min(1).optional(),
});
export type IssueLicenseInput = z.infer<typeof issueLicenseRequestSchema>;

export const revokeLicenseRequestSchema = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().min(1).optional(),
});
export type RevokeLicenseInput = z.infer<typeof revokeLicenseRequestSchema>;

export const activationCompleteRequestSchema = z.object({
  licenseFile: z.string().min(1),
});
export type ActivationCompleteInput = z.infer<typeof activationCompleteRequestSchema>;

export const flagOverrideRequestSchema = z.object({
  flagKey: z.enum(ALL_FEATURE_FLAGS as unknown as [string, ...string[]]),
  enabled: z.boolean(),
});
export type FlagOverrideInput = z.infer<typeof flagOverrideRequestSchema>;
