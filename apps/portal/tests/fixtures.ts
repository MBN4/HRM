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
  employeeASalary: number;
  employeeBEmail: string;
  branchAUsId: string;
  branchAQaId: string;
  analyticsDate: string;
}

export const FIXTURES_PATH = `${__dirname}/.fixtures.json`;
