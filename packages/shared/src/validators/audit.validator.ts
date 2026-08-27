import { z } from 'zod';

/** `GET /audit` query params — every filter is optional; an empty query returns the tenant's most recent entries. */
export const auditQuerySchema = z.object({
  entityType: z.string().min(1).max(200).optional(),
  entityId: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(200).optional(),
  actorUserId: z.string().uuid().optional(),
  /** Returns entries strictly OLDER than this ISO timestamp — pass the last page's oldest `occurredAt` to page further back. */
  before: z.string().datetime().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
