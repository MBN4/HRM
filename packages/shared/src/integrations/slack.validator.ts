import { z } from 'zod';

/** Per-tenant Slack incoming-webhook config (step 3.3) — see docs/conventions/integrations.md. */
export const setSlackWorkspaceConfigSchema = z.object({
  webhookUrl: z.string().url(),
  enabled: z.boolean().default(true),
});
export type SetSlackWorkspaceConfigInput = z.infer<typeof setSlackWorkspaceConfigSchema>;
