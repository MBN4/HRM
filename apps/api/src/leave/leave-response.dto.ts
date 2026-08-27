export class LeaveRequestResponseDto {
  id!: string;
  employeeId!: string;
  leaveType!: string;
  startDate!: string;
  endDate!: string;
  days!: number;
  reason!: string | null;
  status!: string;
  workflowInstanceId!: string | null;
  decidedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;

  constructor(partial: LeaveRequestResponseDto) {
    Object.assign(this, partial);
  }
}

export class LeaveBalanceResponseDto {
  id!: string;
  employeeId!: string;
  leaveType!: string;
  periodYear!: number;
  entitledDays!: number;
  accruedDays!: number;
  carriedOverDays!: number;
  usedDays!: number;
  availableDays!: number;

  constructor(partial: LeaveBalanceResponseDto) {
    Object.assign(this, partial);
  }
}
