import { z } from 'zod';

/**
 * ONE generic, tenant-configurable checklist mini-engine shared by
 * Onboarding and Offboarding — see docs/conventions/recruitment-lifecycle.md.
 * `ChecklistAssigneeRule` deliberately mirrors the SHAPE of 0.7's
 * `ApproverRule` (`SPECIFIC_USER`/`ROLE`/`MANAGER`) — the same "who does
 * this land on" problem shows up here — but is NOT that type, reused, or
 * imported: a checklist task needs a single assignee resolved once, never
 * routing/sequencing/multi-step approval, so pulling in the whole workflow
 * condition/approver-rule machinery would be reuse in name only. This is a
 * small, purpose-built, closed shape with its own resolver
 * (`apps/api/src/checklists/checklist-assignee-resolver.util.ts`).
 */
export const CHECKLIST_PROCESS_TYPES = ['ONBOARDING', 'OFFBOARDING'] as const;
export type ChecklistProcessTypeKey = (typeof CHECKLIST_PROCESS_TYPES)[number];

export type ChecklistAssigneeRule = { type: 'SPECIFIC_USER'; userId: string } | { type: 'ROLE'; roleName: string } | { type: 'MANAGER' };

export const checklistAssigneeRuleSchema: z.ZodType<ChecklistAssigneeRule> = z.union([
  z.object({ type: z.literal('SPECIFIC_USER'), userId: z.string().uuid() }),
  z.object({ type: z.literal('ROLE'), roleName: z.string().min(1) }),
  z.object({ type: z.literal('MANAGER') }),
]);

export const checklistTaskDefinitionSchema = z
  .object({
    key: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    category: z.string().min(1).max(50),
    assigneeRule: checklistAssigneeRuleSchema,
    requiresDocument: z.boolean().default(false),
  })
  .strict();
export type ChecklistTaskDefinition = z.infer<typeof checklistTaskDefinitionSchema>;

export const createChecklistTemplateSchema = z
  .object({
    processType: z.enum(CHECKLIST_PROCESS_TYPES),
    name: z.string().min(1).max(200),
    tasks: z
      .array(checklistTaskDefinitionSchema)
      .min(1, 'A checklist template needs at least one task.')
      .refine((tasks) => new Set(tasks.map((task) => task.key)).size === tasks.length, {
        message: 'Task keys must be unique within a template.',
      }),
  })
  .strict();
export type CreateChecklistTemplateInput = z.infer<typeof createChecklistTemplateSchema>;
