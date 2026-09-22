export const TEST_PASSWORD = 'Password123!';

export interface PortalTestFixtures {
  tenantASlug: string;
  tenantBSlug: string;
  adminAEmail: string;
  managerAEmail: string;
  branchRestrictedManagerEmail: string;
  employeeAEmail: string;
  qaEmployeeAEmail: string;
  employeeAId: string;
  employeeAUserId: string;
  employeeASalary: number;
  employeeBEmail: string;
  branchAUsId: string;
  branchAQaId: string;
  branchAPkId: string;
  pkEmployeeAEmail: string;
  pkEmployeeAEmployeeId: string;
  analyticsDate: string;
  payrollNoSalaryEmail: string;
  managerAEmployeeId: string;
  qaEmployeeAEmployeeId: string;
  ratingScaleKey: string;
  ratingScaleName: string;
  calibrationCycleId: string;
  seededCandidateId: string;
  seededCandidateName: string;
  seededApplicationId: string;
  seededPostingId: string;
  offboardingTargetEmployeeId: string;
  passwordResetTargetEmail: string;
  passwordResetTargetUserId: string;
}

export const FIXTURES_PATH = `${__dirname}/.fixtures.json`;
