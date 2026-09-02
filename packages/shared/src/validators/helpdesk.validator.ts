import { z } from 'zod';

/** HR Helpdesk / Ticketing (step 3.1) — see docs/conventions/operations-modules.md. */
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TicketPriorityKey = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatusKey = (typeof TICKET_STATUSES)[number];

export const createTicketCategorySchema = z
  .object({
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    defaultSlaMinutes: z.number().int().positive().optional(),
  })
  .strict();
export type CreateTicketCategoryInput = z.infer<typeof createTicketCategorySchema>;

export const createTicketSchema = z
  .object({
    categoryId: z.string().uuid(),
    subject: z.string().min(1).max(200),
    description: z.string().min(1).max(5000),
    priority: z.enum(TICKET_PRIORITIES).default('MEDIUM'),
  })
  .strict();
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const addTicketCommentSchema = z
  .object({
    body: z.string().min(1).max(5000),
  })
  .strict();
export type AddTicketCommentInput = z.infer<typeof addTicketCommentSchema>;

export const assignTicketSchema = z
  .object({
    assignedToUserId: z.string().uuid(),
  })
  .strict();
export type AssignTicketInput = z.infer<typeof assignTicketSchema>;

export const updateTicketStatusSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
  })
  .strict();
export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;
