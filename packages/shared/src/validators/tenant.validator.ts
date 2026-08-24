import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
