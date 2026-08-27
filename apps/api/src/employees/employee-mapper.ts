import { Injectable } from '@nestjs/common';
import type { Employee, EmployeeDependent, EmployeeEmergencyContact, Prisma } from '@hrm/db';
import { EncryptionService } from '../common/encryption/encryption.service';
import { CustomFieldValueService } from '../custom-fields/custom-field-value.service';
import { EMPLOYEE_ENTITY_TYPE } from './employee.constants';
import { EmployeeResponseDto } from './employee-response.dto';

/**
 * Assembles the full `EmployeeResponseDto` for one `Employee` row —
 * decrypting bank/salary fields (field-level gating happens later, at
 * serialization, via `@RequiresPermission()` — see employee-response.dto.ts)
 * and pulling in this employee's dependents/emergency contacts/custom field
 * values. The ONE place that does this assembly, so `EmployeeService`'s
 * create/update/get/list methods all produce identically-shaped responses.
 */
@Injectable()
export class EmployeeMapper {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly customFieldValues: CustomFieldValueService,
  ) {}

  async toDto(tx: Prisma.TransactionClient, row: Employee): Promise<EmployeeResponseDto> {
    const [dependents, emergencyContacts, customFields] = await Promise.all([
      tx.employeeDependent.findMany({ where: { employeeId: row.id }, orderBy: { createdAt: 'asc' } }),
      tx.employeeEmergencyContact.findMany({ where: { employeeId: row.id }, orderBy: { createdAt: 'asc' } }),
      this.customFieldValues.getValues(tx, EMPLOYEE_ENTITY_TYPE, row.id),
    ]);

    const bankDetails =
      row.bankAccountNumberEncrypted && row.bankNameEncrypted
        ? {
            accountNumber: this.encryption.decrypt(row.bankAccountNumberEncrypted),
            bankName: this.encryption.decrypt(row.bankNameEncrypted),
            routingCode: this.encryption.decryptOptional(row.bankRoutingCodeEncrypted),
          }
        : null;

    const compensation = row.baseSalaryEncrypted
      ? {
          baseSalary: Number(this.encryption.decrypt(row.baseSalaryEncrypted)),
          salaryCurrency: row.salaryCurrency,
        }
      : null;

    return new EmployeeResponseDto({
      id: row.id,
      employeeCode: row.employeeCode,
      userId: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      personalEmail: row.personalEmail,
      phone: row.phone,
      dateOfBirth: row.dateOfBirth?.toISOString() ?? null,
      gender: row.gender,
      branchId: row.branchId,
      departmentId: row.departmentId,
      designationId: row.designationId,
      employmentType: row.employmentType,
      joinDate: row.joinDate.toISOString(),
      status: row.status,
      managerId: row.managerId,
      statutoryFields: (row.statutoryFields as Record<string, string>) ?? {},
      bankDetails,
      compensation,
      dependents: dependents.map(mapDependent),
      emergencyContacts: emergencyContacts.map(mapEmergencyContact),
      customFields: customFields.values,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
}

function mapDependent(row: EmployeeDependent) {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    dateOfBirth: row.dateOfBirth?.toISOString() ?? null,
  };
}

function mapEmergencyContact(row: EmployeeEmergencyContact) {
  return { id: row.id, name: row.name, relationship: row.relationship, phone: row.phone };
}
