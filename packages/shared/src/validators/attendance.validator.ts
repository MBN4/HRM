import { z } from 'zod';

/**
 * The Attendance module's schema — see docs/conventions/attendance.md.
 * `AttendanceRecord`/`ShiftDefinition`/`RosterAssignment`/
 * `AttendanceRegularization` are all CLOSED, code-level catalogs (source/
 * status enums), the same "some things ARE a fixed, closed set" exception
 * `LeaveType`/`CustomFieldType` already take to this codebase's usual
 * free-form-string convention — none of this is tenant-extensible data.
 */

export const ATTENDANCE_SOURCES = ['WEB', 'MOBILE', 'BIOMETRIC', 'MANUAL'] as const;
export type AttendanceSourceKey = (typeof ATTENDANCE_SOURCES)[number];

export const ATTENDANCE_RECORD_STATUSES = ['OPEN', 'CLOSED'] as const;
export type AttendanceRecordStatusKey = (typeof ATTENDANCE_RECORD_STATUSES)[number];

export const ATTENDANCE_REGULARIZATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELED'] as const;
export type AttendanceRegularizationStatusKey = (typeof ATTENDANCE_REGULARIZATION_STATUSES)[number];

export const ATTENDANCE_DAY_STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'WEEKEND', 'HOLIDAY'] as const;
export type AttendanceDayStatusKey = (typeof ATTENDANCE_DAY_STATUSES)[number];

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Clock-in/out bodies arrive as MULTIPART form fields (an optional selfie
 * file alongside them, via `FileInterceptor` — the same "binary content
 * genuinely doesn't fit a JSON string" posture `EmployeeDocumentsController`
 * (1.1) already established), so the numeric/string fields land as raw
 * strings, not a parsed JSON body — these schemas run against the
 * manually-assembled plain object the controller builds from
 * `@Body()`/`@UploadedFile()`, the same "validate the parsed shape, not the
 * multipart wire format" approach that controller already uses for
 * `documentType`.
 */
/** Only WEB/MOBILE may be self-reported through these routes — BIOMETRIC/MANUAL are set internally (the device seam, and regularization) and never accepted from a client body. */
export const SELF_SERVICE_ATTENDANCE_SOURCES = ['WEB', 'MOBILE'] as const;

export const clockInSchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    source: z.enum(SELF_SERVICE_ATTENDANCE_SOURCES).default('WEB'),
    lat: z.coerce.number().min(-90).max(90).optional(),
    long: z.coerce.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((input) => (input.lat === undefined) === (input.long === undefined), {
    message: 'lat and long must be provided together.',
    path: ['long'],
  });
export type ClockInInput = z.infer<typeof clockInSchema>;

export const clockOutSchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    source: z.enum(SELF_SERVICE_ATTENDANCE_SOURCES).default('WEB'),
    lat: z.coerce.number().min(-90).max(90).optional(),
    long: z.coerce.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((input) => (input.lat === undefined) === (input.long === undefined), {
    message: 'lat and long must be provided together.',
    path: ['long'],
  });
export type ClockOutInput = z.infer<typeof clockOutSchema>;

export const manualPunchSchema = z
  .object({
    employeeCode: z.string().min(1).max(64),
    direction: z.enum(['IN', 'OUT']),
    deviceId: z.string().min(1).max(200),
    /** Defaults to "now" — a real device may report a punch slightly after it actually happened. */
    timestamp: z.coerce.date().optional(),
  })
  .strict();
export type ManualPunchInput = z.infer<typeof manualPunchSchema>;

export const createShiftDefinitionSchema = z
  .object({
    name: z.string().min(1).max(200),
    startTime: z.string().regex(HHMM_REGEX, 'startTime must be "HH:mm"'),
    endTime: z.string().regex(HHMM_REGEX, 'endTime must be "HH:mm"'),
    breakMinutes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CreateShiftDefinitionInput = z.infer<typeof createShiftDefinitionSchema>;

export const createRosterAssignmentSchema = z
  .object({
    employeeId: z.string().uuid(),
    shiftDefinitionId: z.string().uuid(),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().optional(),
  })
  .strict()
  .refine((input) => !input.effectiveTo || input.effectiveTo >= input.effectiveFrom, {
    message: 'effectiveTo must be on or after effectiveFrom.',
    path: ['effectiveTo'],
  });
export type CreateRosterAssignmentInput = z.infer<typeof createRosterAssignmentSchema>;

export const createRegularizationSchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    /** Omitted = a fully missing punch for `workDate` (no existing record at all). */
    attendanceRecordId: z.string().uuid().optional(),
    workDate: z.coerce.date(),
    requestedClockInAt: z.coerce.date().optional(),
    requestedClockOutAt: z.coerce.date().optional(),
    reason: z.string().min(1).max(2000),
  })
  .strict()
  .refine((input) => Boolean(input.requestedClockInAt) || Boolean(input.requestedClockOutAt), {
    message: 'At least one of requestedClockInAt/requestedClockOutAt is required.',
    path: ['requestedClockInAt'],
  });
export type CreateRegularizationInput = z.infer<typeof createRegularizationSchema>;

export const runAttendanceSummarySchema = z
  .object({
    workDate: z.coerce.date(),
    branchId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
  })
  .strict();
export type RunAttendanceSummaryInput = z.infer<typeof runAttendanceSummarySchema>;

/** Branch geo-fence config — see docs/conventions/attendance.md. All three null = geo-fencing OFF for that branch. */
export const branchGeofenceSchema = z
  .object({
    geofenceLat: z.number().min(-90).max(90).nullable(),
    geofenceLong: z.number().min(-180).max(180).nullable(),
    geofenceRadiusMeters: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(
    (input) =>
      (input.geofenceLat === null) === (input.geofenceLong === null) &&
      (input.geofenceLat === null) === (input.geofenceRadiusMeters === null),
    { message: 'geofenceLat/geofenceLong/geofenceRadiusMeters must be all set or all null.', path: ['geofenceRadiusMeters'] },
  );
export type BranchGeofenceInput = z.infer<typeof branchGeofenceSchema>;
