/**
 * What a person's DAY is, for schedule display and coverage (step 8.2). Pure; mirrors the
 * ordering the day-status classifier uses so the roster, "my schedule" and the attendance
 * graph never disagree about whether a day is a working day:
 *
 *   rostered day off  >  (weekend / public holiday — unless a shift is ROSTERED that day)
 *     >  approved leave  >  rostered shift  >  standing shift  >  plain default hours
 */
export type ScheduleDayKind =
  'SHIFT' | 'DAY_OFF' | 'DEFAULT_HOURS' | 'WEEKEND' | 'HOLIDAY' | 'LEAVE';

export interface ScheduleDayInput {
  /** The roster cell for the day, if any (a day off or a shift). */
  cell: { dayOff: boolean; shiftDefinitionId: string | null } | null;
  /** The standing layer's shift id (null = custom hours / Country Pack). */
  standingShiftId: string | null;
  isWeekend: boolean;
  isHoliday: boolean;
  onLeave: boolean;
}

export interface ScheduleDay {
  kind: ScheduleDayKind;
  shiftId: string | null;
  /** Where the shift came from. */
  via: 'ROSTER' | 'STANDING' | null;
}

export function scheduleDay(input: ScheduleDayInput): ScheduleDay {
  const rosteredShift = input.cell && !input.cell.dayOff ? input.cell.shiftDefinitionId : null;
  if (input.cell?.dayOff) return { kind: 'DAY_OFF', shiftId: null, via: 'ROSTER' };
  if (!rosteredShift && input.isWeekend) return { kind: 'WEEKEND', shiftId: null, via: null };
  if (!rosteredShift && input.isHoliday) return { kind: 'HOLIDAY', shiftId: null, via: null };
  if (input.onLeave)
    return {
      kind: 'LEAVE',
      shiftId: rosteredShift ?? input.standingShiftId,
      via: rosteredShift ? 'ROSTER' : input.standingShiftId ? 'STANDING' : null,
    };
  if (rosteredShift) return { kind: 'SHIFT', shiftId: rosteredShift, via: 'ROSTER' };
  if (input.standingShiftId)
    return { kind: 'SHIFT', shiftId: input.standingShiftId, via: 'STANDING' };
  return { kind: 'DEFAULT_HOURS', shiftId: null, via: null };
}

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const parseYmd = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export function eachYmd(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = parseYmd(from).getTime(), end = parseYmd(to).getTime(); t <= end; t += 86_400_000)
    out.push(ymd(new Date(t)));
  return out;
}

export const addDaysYmd = (s: string, n: number): string =>
  ymd(new Date(parseYmd(s).getTime() + n * 86_400_000));
