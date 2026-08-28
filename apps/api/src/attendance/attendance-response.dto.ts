export class AttendanceRecordResponseDto {
  id!: string;
  employeeId!: string;
  branchId!: string;
  workDate!: string;
  shiftDefinitionId!: string | null;
  clockInAt!: string;
  clockInSource!: string;
  clockInLat!: number | null;
  clockInLong!: number | null;
  clockOutAt!: string | null;
  clockOutSource!: string | null;
  clockOutLat!: number | null;
  clockOutLong!: number | null;
  status!: string;
  workedMinutes!: number | null;
  overtimeMinutes!: number;
  lateMinutes!: number;
  createdAt!: string;
  updatedAt!: string;

  constructor(partial: AttendanceRecordResponseDto) {
    Object.assign(this, partial);
  }
}

export class AttendanceRegularizationResponseDto {
  id!: string;
  employeeId!: string;
  attendanceRecordId!: string | null;
  workDate!: string;
  requestedClockInAt!: string | null;
  requestedClockOutAt!: string | null;
  reason!: string;
  status!: string;
  workflowInstanceId!: string | null;
  decidedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;

  constructor(partial: AttendanceRegularizationResponseDto) {
    Object.assign(this, partial);
  }
}

export class AttendanceDailySummaryResponseDto {
  id!: string;
  employeeId!: string;
  branchId!: string;
  workDate!: string;
  status!: string;
  workedMinutes!: number;
  overtimeMinutes!: number;
  lateMinutes!: number;
  computedAt!: string;

  constructor(partial: AttendanceDailySummaryResponseDto) {
    Object.assign(this, partial);
  }
}
