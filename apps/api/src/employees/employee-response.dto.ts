import { PERMISSIONS } from '@hrm/shared';
import { RequiresPermission } from '../common/permissions/requires-permission.decorator';

export interface EmployeeBankDetails {
  accountNumber: string;
  bankName: string;
  routingCode: string | null;
}

export interface EmployeeCompensation {
  baseSalary: number;
  salaryCurrency: string | null;
}

export interface EmployeeDependentDto {
  id: string;
  name: string;
  relationship: string;
  dateOfBirth: string | null;
}

export interface EmployeeEmergencyContactDto {
  id: string;
  name: string;
  relationship: string;
  phone: string;
}

/**
 * The real, primary use of the field-level permission pattern established
 * (as a demo) in 0.4 — see docs/conventions/field-level-permissions.md.
 * Every field is always included EXCEPT `compensation`, which is entirely
 * OMITTED (not nulled) for any caller lacking `salary.view` — decrypted
 * server-side either way (see `EmployeeMapper`), gating happens only at
 * serialization. `bankDetails` is NOT field-gated (only salary was asked to
 * be) but IS still encrypted at rest — see docs/conventions/employee.md for
 * why these are two independent, intentionally different controls.
 */
export class EmployeeResponseDto {
  id!: string;
  employeeCode!: string;
  userId!: string | null;

  firstName!: string;
  lastName!: string;
  personalEmail!: string | null;
  phone!: string | null;
  dateOfBirth!: string | null;
  gender!: string | null;

  branchId!: string;
  departmentId!: string | null;
  designationId!: string | null;
  employmentType!: string;
  joinDate!: string;
  status!: string;
  managerId!: string | null;

  statutoryFields!: Record<string, string>;

  bankDetails!: EmployeeBankDetails | null;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  compensation!: EmployeeCompensation | null;

  dependents!: EmployeeDependentDto[];
  emergencyContacts!: EmployeeEmergencyContactDto[];
  customFields!: Record<string, unknown>;

  createdAt!: string;
  updatedAt!: string;

  constructor(partial: EmployeeResponseDto) {
    Object.assign(this, partial);
  }
}
