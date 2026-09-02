import { z } from 'zod';

/**
 * Announcements & Policies (step 3.1) — see
 * docs/conventions/operations-modules.md. `targetBranchIds`/
 * `targetDepartmentIds` empty = every branch/department (no restriction).
 */
export const createAnnouncementSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(10000),
    targetBranchIds: z.array(z.string().uuid()).default([]),
    targetDepartmentIds: z.array(z.string().uuid()).default([]),
    publish: z.boolean().default(false),
  })
  .strict();
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const createPolicySchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20000),
    requiresAcknowledgment: z.boolean().default(true),
    publish: z.boolean().default(false),
  })
  .strict();
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
