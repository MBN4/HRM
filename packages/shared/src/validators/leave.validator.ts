import { z } from 'zod';

/**
 * The Leave module's schema — see docs/conventions/leave.md. `LEAVE_TYPES`
 * is a CLOSED, code-level catalog (unlike `CustomFieldDefinition.entityType`
 * or `WorkflowInstance.entityType`'s free-form-string pattern) because it
 * mirrors the four fixed keys `@hrm/shared`'s `leaveDefaultsSchema` (0.5)
 * already commits to (`annualDays`/`sickDays`/`maternityDays`/
 * `paternityDays`) — the same "some things ARE a fixed, closed set"
 * exception `CustomFieldType` takes to the rest of this codebase's
 * free-form-string convention. What's entirely DATA-driven, never
 * hardcoded, is the ENTITLEMENT (day count) for each type — see
 * LeaveEntitlementService.
 */
export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY'] as const;
export type LeaveTypeKey = (typeof LEAVE_TYPES)[number];

export const LEAVE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELED'] as const;
export type LeaveRequestStatusKey = (typeof LEAVE_REQUEST_STATUSES)[number];

export const createLeaveRequestSchema = z
  .object({
    /** Defaults to the caller's own linked Employee record; submitting on behalf of someone else requires `leave.approve`. */
    employeeId: z.string().uuid().optional(),
    leaveType: z.enum(LEAVE_TYPES),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    reason: z.string().max(2000).optional(),
  })
  .strict()
  .refine((input) => input.endDate >= input.startDate, {
    message: 'endDate must be on or after startDate.',
    path: ['endDate'],
  });
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;

export const adjustLeaveBalanceSchema = z
  .object({
    leaveType: z.enum(LEAVE_TYPES),
    periodYear: z.number().int().min(2000).max(2100).optional(),
    /** Positive to grant, negative to deduct — applied to `accruedDays`. */
    deltaDays: z.number(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type AdjustLeaveBalanceInput = z.infer<typeof adjustLeaveBalanceSchema>;

export const runLeaveAccrualSchema = z
  .object({
    periodYear: z.number().int().min(2000).max(2100),
    periodMonth: z.number().int().min(1).max(12),
  })
  .strict();
export type RunLeaveAccrualInput = z.infer<typeof runLeaveAccrualSchema>;
