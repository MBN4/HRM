import { OvertimeRules } from '@hrm/shared';
import { branchLocalToUtc } from './attendance-timezone.util';

export interface RecordMetricsShift {
  startTime: string;
  breakMinutes: number;
}

export interface RecordMetricsInput {
  clockInAt: Date;
  clockOutAt: Date;
  /** The record's own frozen `workDate` — see docs/conventions/attendance.md; needed to resolve the shift's SCHEDULED start as a real instant. */
  workDate: Date;
  timeZone: string;
  shift: RecordMetricsShift | null;
  overtimeRules: OvertimeRules;
}

export interface RecordMetrics {
  workedMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
}

/**
 * Pure computation shared by clock-out (`AttendanceClockService`) and
 * regularization approval (`AttendanceRegularizationWorkflowEventsListener`)
 * — both close out a record's `clockInAt`/`clockOutAt` and need the exact
 * same worked/overtime/late derivation, so this is the ONE place that logic
 * lives. `overtimeRules.dailyThresholdHours` is resolved from the effective
 * Country Pack (THE RULE, country-packs.md — never a country-code branch);
 * `weeklyThresholdHours` aggregation is a documented, out-of-scope
 * simplification for this step (see docs/conventions/attendance.md), the
 * same "documented gap" posture 1.2's leave module already takes for
 * leaver pro-ration.
 */
export function computeRecordMetrics(input: RecordMetricsInput): RecordMetrics {
  const rawMinutes = Math.round((input.clockOutAt.getTime() - input.clockInAt.getTime()) / 60_000);
  const workedMinutes = Math.max(0, rawMinutes - (input.shift?.breakMinutes ?? 0));

  let overtimeMinutes = 0;
  if (input.overtimeRules.dailyThresholdHours) {
    overtimeMinutes = Math.max(0, workedMinutes - input.overtimeRules.dailyThresholdHours * 60);
  }

  let lateMinutes = 0;
  if (input.shift) {
    const scheduledStart = branchLocalToUtc(input.workDate, input.shift.startTime, input.timeZone);
    lateMinutes = Math.max(0, Math.round((input.clockInAt.getTime() - scheduledStart.getTime()) / 60_000));
  }

  return { workedMinutes, overtimeMinutes, lateMinutes };
}
