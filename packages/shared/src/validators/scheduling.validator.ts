import { z } from 'zod';
import { defaultHalfDayThreshold, hhmmSchema, requiredHoursOf } from './working-hours.validator';

/**
 * Shift scheduling & rostering (step 8.2) — see docs/conventions/shift-scheduling.md.
 *
 * THE RECONCILED MODEL: a shift is a named, reusable time block whose fields map 1:1 onto
 * the working-hours parameters (start, break, grace, half-day). It never redefines them:
 * `shiftToWorkingHours` is the ONE mapping, used by the resolver and the UI alike.
 */

export const SCHEDULING_MAX_RANGE_DAYS = 42;
export const SCHEDULING_MAX_CELLS_PER_REQUEST = 500;

/** The `entityType` a shift swap starts its 0.7 `WorkflowInstance` under. */
export const SHIFT_SWAP_ENTITY_TYPE = 'ShiftSwap';

export const ROSTER_ASSIGNMENT_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type RosterAssignmentStatusKey = (typeof ROSTER_ASSIGNMENT_STATUSES)[number];

export const SHIFT_SWAP_STATUSES = [
  'AWAITING_PEER',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'DECLINED',
  'CANCELED',
] as const;
export type ShiftSwapStatusKey = (typeof SHIFT_SWAP_STATUSES)[number];

const toMinutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Length of a shift in minutes; an end at/before the start means it crosses midnight (22:00-06:00 = 480). */
export function shiftDurationMinutes(startTime: string, endTime: string): number {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  return e > s ? e - s : e + 1440 - s;
}

export interface ShiftHoursInput {
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  halfDayThresholdHours: number | null;
}

/** The working-hours policy a shift stands for. requiredHours (= work + break) is the shift's full start->end length. */
export function shiftToWorkingHours(shift: ShiftHoursInput) {
  const requiredHours =
    Math.round((shiftDurationMinutes(shift.startTime, shift.endTime) / 60) * 100) / 100;
  const breakHours = Math.round((shift.breakMinutes / 60) * 100) / 100;
  const workHours = Math.round((requiredHours - breakHours) * 100) / 100;
  const derived = shift.halfDayThresholdHours == null;
  return {
    startTime: shift.startTime,
    workHours,
    breakHours,
    requiredHours: requiredHoursOf(workHours, breakHours),
    graceMinutes: shift.graceMinutes,
    halfDayThresholdHours: derived
      ? defaultHalfDayThreshold(workHours, breakHours)
      : (shift.halfDayThresholdHours as number),
    halfDayThresholdDerived: derived,
  };
}

export const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date');

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const shiftFields = {
  name: z.string().trim().min(1).max(200),
  startTime: hhmmSchema,
  endTime: hhmmSchema,
  breakMinutes: z.number().int().min(0).max(600).default(0),
  graceMinutes: z.number().int().min(0).max(240).default(15),
  /** Null/omitted = derive requiredHours / 2, exactly like the working-hours policy. */
  halfDayThresholdHours: z.number().gt(0).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour')
    .nullable()
    .optional(),
  /** Coverage target: fewer people than this on a day shows as a gap. */
  minStaffing: z.number().int().min(0).max(100000).nullable().optional(),
};

function saneShift(
  v: {
    startTime?: string;
    endTime?: string;
    breakMinutes?: number;
    halfDayThresholdHours?: number | null;
  },
  ctx: z.RefinementCtx,
) {
  if (v.startTime === undefined || v.endTime === undefined) return;
  if (v.startTime === v.endTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: 'A shift cannot start and end at the same time',
    });
    return;
  }
  const duration = shiftDurationMinutes(v.startTime, v.endTime);
  if ((v.breakMinutes ?? 0) >= duration) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['breakMinutes'],
      message: 'The break must be shorter than the shift',
    });
  }
  if (v.halfDayThresholdHours != null && v.halfDayThresholdHours >= duration / 60) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['halfDayThresholdHours'],
      message: 'halfDayThresholdHours must be less than the shift length',
    });
  }
}

export const createShiftDefinitionSchema = z.object(shiftFields).strict().superRefine(saneShift);
export type CreateShiftDefinitionInput = z.infer<typeof createShiftDefinitionSchema>;

export const updateShiftDefinitionSchema = z
  .object({
    name: shiftFields.name.optional(),
    startTime: shiftFields.startTime.optional(),
    endTime: shiftFields.endTime.optional(),
    breakMinutes: z.number().int().min(0).max(600).optional(),
    graceMinutes: z.number().int().min(0).max(240).optional(),
    halfDayThresholdHours: shiftFields.halfDayThresholdHours,
    color: shiftFields.color,
    minStaffing: shiftFields.minStaffing,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateShiftDefinitionInput = z.infer<typeof updateShiftDefinitionSchema>;

export const setStandingShiftSchema = z.object({ shiftDefinitionId: z.string().uuid() }).strict();
export type SetStandingShiftInput = z.infer<typeof setStandingShiftSchema>;

const rangeRefine = (v: { from: string; to: string }, ctx: z.RefinementCtx) => {
  const span = daysBetween(v.from, v.to);
  if (span < 0)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to must be on or after from',
    });
  else if (span + 1 > SCHEDULING_MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: `A range is at most ${SCHEDULING_MAX_RANGE_DAYS} days`,
    });
  }
};

/** Roster grid / coverage window. `departmentId` narrows to a team (and its sub-teams); `branchId` to a branch. */
export const rosterGridQuerySchema = z
  .object({
    from: ymdSchema,
    to: ymdSchema,
    departmentId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
  })
  .superRefine(rangeRefine);
export type RosterGridQuery = z.infer<typeof rosterGridQuerySchema>;

export const myScheduleQuerySchema = z
  .object({ from: ymdSchema.optional(), to: ymdSchema.optional() })
  .superRefine((v, ctx) => {
    if (v.from && v.to) rangeRefine({ from: v.from, to: v.to }, ctx);
  });
export type MyScheduleQuery = z.infer<typeof myScheduleQuerySchema>;

/** One calendar cell: `shiftDefinitionId` set = that shift; `dayOff` = rostered day off; neither = CLEAR the cell (fall back to the standing shift). */
export const rosterCellSchema = z
  .object({
    employeeId: z.string().uuid(),
    date: ymdSchema,
    shiftDefinitionId: z.string().uuid().nullable().optional(),
    dayOff: z.boolean().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((c) => !(c.dayOff && c.shiftDefinitionId), {
    message: 'A day off cannot also carry a shift',
    path: ['dayOff'],
  });
export type RosterCellInput = z.infer<typeof rosterCellSchema>;

export const setRosterCellsSchema = z
  .object({ cells: z.array(rosterCellSchema).min(1).max(SCHEDULING_MAX_CELLS_PER_REQUEST) })
  .strict();
export type SetRosterCellsInput = z.infer<typeof setRosterCellsSchema>;

/** Copy every cell in [sourceFrom, sourceTo] to the same weekdays starting at targetFrom (a rotation helper). New cells are DRAFT. */
export const copyRosterSchema = z
  .object({
    sourceFrom: ymdSchema,
    sourceTo: ymdSchema,
    targetFrom: ymdSchema,
    departmentId: z.string().uuid().optional(),
    employeeIds: z.array(z.string().uuid()).max(2000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    rangeRefine({ from: v.sourceFrom, to: v.sourceTo }, ctx);
    if (v.targetFrom === v.sourceFrom)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetFrom'],
        message: 'The target must differ from the source',
      });
  });
export type CopyRosterInput = z.infer<typeof copyRosterSchema>;

export const publishRosterSchema = z
  .object({
    from: ymdSchema,
    to: ymdSchema,
    departmentId: z.string().uuid().optional(),
    employeeIds: z.array(z.string().uuid()).max(2000).optional(),
  })
  .strict()
  .superRefine(rangeRefine);
export type PublishRosterInput = z.infer<typeof publishRosterSchema>;

export const createShiftSwapSchema = z
  .object({
    date: ymdSchema,
    counterpartEmployeeId: z.string().uuid(),
    reason: z.string().max(1000).optional(),
  })
  .strict();
export type CreateShiftSwapInput = z.infer<typeof createShiftSwapSchema>;

export const respondShiftSwapSchema = z.object({ accept: z.boolean() }).strict();
export type RespondShiftSwapInput = z.infer<typeof respondShiftSwapSchema>;
