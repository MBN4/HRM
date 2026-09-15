import { z } from 'zod';
import { DATA_CATEGORIES, DATA_SUBJECT_TYPES, PRIVACY_REQUEST_STATUSES, PRIVACY_REQUEST_TYPES } from '../constants/privacy';

/**
 * Data privacy & residency (step 6.1) — see
 * docs/conventions/privacy-residency.md. Tenant-facing request DTOs
 * (`apps/api/src/privacy`); the platform/vendor-facing ones live alongside
 * every other platform DTO in `platform.validator.ts`, the SAME split
 * `partitioning`'s own tenant-override-vs-platform-config schemas already
 * establish.
 */

export const dataSubjectTypeSchema = z.enum(DATA_SUBJECT_TYPES);
export const dataCategorySchema = z.enum(DATA_CATEGORIES);

export const createDataSubjectRequestSchema = z
  .object({
    requestType: z.enum(PRIVACY_REQUEST_TYPES),
    subjectType: dataSubjectTypeSchema,
    subjectId: z.string().uuid(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type CreateDataSubjectRequestInput = z.infer<typeof createDataSubjectRequestSchema>;

export const listDataSubjectRequestsQuerySchema = z.object({
  status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
  subjectType: dataSubjectTypeSchema.optional(),
  take: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type ListDataSubjectRequestsQuery = z.infer<typeof listDataSubjectRequestsQuerySchema>;

export const recordConsentRequestSchema = z
  .object({
    subjectType: dataSubjectTypeSchema,
    subjectId: z.string().uuid(),
    purpose: z.string().min(1).max(200),
    granted: z.boolean(),
    source: z.string().min(1).max(200),
  })
  .strict();
export type RecordConsentInput = z.infer<typeof recordConsentRequestSchema>;

export const listConsentRecordsQuerySchema = z.object({
  subjectType: dataSubjectTypeSchema.optional(),
  subjectId: z.string().uuid().optional(),
});
export type ListConsentRecordsQuery = z.infer<typeof listConsentRecordsQuerySchema>;

export const upsertTenantDataRetentionOverrideRequestSchema = z.object({
  retentionMonths: z.number().int().min(1).max(1200),
});
export type UpsertTenantDataRetentionOverrideInput = z.infer<typeof upsertTenantDataRetentionOverrideRequestSchema>;
