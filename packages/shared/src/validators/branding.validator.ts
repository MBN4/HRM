import { z } from 'zod';

/**
 * White-label / branding request DTOs — step 4.3. See
 * docs/conventions/white-label.md. Same "JSON has no schema-level
 * guarantee of its own" posture every other mutation in this codebase
 * takes: `ZodValidationPipe` validates every one of these at the route.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const hexColorSchema = z.string().regex(HEX_COLOR, 'Must be a hex color like "#0f766e".');

/** `PUT /branding` — full-replace, like every other JSON-config mutation in this codebase (TenantCountryOverride, TenantFeatureFlagOverride, ...). */
export const updateBrandingRequestSchema = z
  .object({
    productName: z.string().trim().min(1).max(80).nullable().optional(),
    primaryColor: hexColorSchema.nullable().optional(),
    secondaryColor: hexColorSchema.nullable().optional(),
    accentColor: hexColorSchema.nullable().optional(),
    loginHeadline: z.string().trim().max(200).nullable().optional(),
    loginSubtext: z.string().trim().max(400).nullable().optional(),
    emailFromName: z.string().trim().max(120).nullable().optional(),
    emailFromAddress: z.string().trim().email().max(200).nullable().optional(),
  })
  .strict();
export type UpdateBrandingInput = z.infer<typeof updateBrandingRequestSchema>;

export const updateRebrandRequestSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateRebrandInput = z.infer<typeof updateRebrandRequestSchema>;

/** Bare hostname only — no scheme, no port, no path (mirrors TenantDomain.domain's own convention). */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Must be a bare hostname, e.g. "hr.acme-corp.example".');

export const requestDomainRequestSchema = z.object({
  domain: domainSchema,
});
export type RequestDomainInput = z.infer<typeof requestDomainRequestSchema>;
