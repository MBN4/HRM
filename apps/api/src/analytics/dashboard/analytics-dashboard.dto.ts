export class AnalyticsDashboardResponseDto {
  range!: { from: string; to: string };

  headcount!: {
    asOfDate: string | null;
    total: number;
    byBranch: { branchId: string; count: number }[];
    byDepartment: { departmentId: string | null; count: number }[];
    byEmploymentType: { employmentType: string; count: number }[];
    byGender: { gender: string | null; count: number }[];
  };

  movement!: {
    joiners: number;
    leavers: number;
    attritionRate: number;
    byBranch: { branchId: string; joiners: number; leavers: number }[];
  };

  attendance!: {
    presentCount: number;
    absentCount: number;
    lateCount: number;
    onLeaveCount: number;
    weekendCount: number;
    holidayCount: number;
    employeeDays: number;
    attendanceRate: number;
    trend: { date: string; presentCount: number; absentCount: number; lateCount: number; employeeCount: number }[];
  };

  leave!: {
    byType: { leaveType: string; entitledDays: number; usedToDate: number; usedInPeriod: number; utilizationRate: number }[];
  };

  constructor(partial: AnalyticsDashboardResponseDto) {
    Object.assign(this, partial);
  }
}
