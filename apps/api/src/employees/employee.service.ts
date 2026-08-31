import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Employee, Prisma } from '@hrm/db';
import type { CreateEmployeeInput, UpdateEmployeeInput } from '@hrm/shared';
import { EncryptionService } from '../common/encryption/encryption.service';
import { CustomFieldValueService } from '../custom-fields/custom-field-value.service';
import { resolveRequiredEmployeeFields } from './employee-country-pack.util';
import { EmployeeMapper } from './employee-mapper';
import { EmployeeResponseDto } from './employee-response.dto';
import { DEFAULT_PAGE_SIZE, EMPLOYEE_ENTITY_TYPE, MAX_PAGE_SIZE } from './employee.constants';

export interface EmployeeListFilters {
  status?: string;
  branchId?: string;
  departmentId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface EmployeeListResult {
  data: EmployeeResponseDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * A plain (non-Prisma-branded) shape for the handful of encrypted columns —
 * deliberately NOT `Partial<Prisma.EmployeeUpdateInput>`: Prisma's `Update`
 * input types brand every field as `X | XFieldUpdateOperationsInput`
 * (Prisma's `{ set: X }` update-operation syntax), and spreading that into
 * a `create()` call's plain-scalar `data` object literal makes TypeScript
 * infer the WHOLE literal against that branded union, not just the spread
 * fields — a real error caught while wiring this up.
 */
interface EncryptedBankAndCompensationFields {
  bankAccountNumberEncrypted?: string | null;
  bankNameEncrypted?: string | null;
  bankRoutingCodeEncrypted?: string | null;
  baseSalaryEncrypted?: string | null;
  salaryCurrency?: string | null;
}

/**
 * The core HR entity's CRUD + business rules — see docs/conventions/employee.md
 * for the full write-up. Every method takes `tx`/`tenantId` explicitly
 * rather than reading them off `TenantContextService` itself, DELIBERATELY:
 * this service is called from both an HTTP request (EmployeesController,
 * which has a `TenantContextService`-backed context) and the bulk-import
 * BullMQ worker (which does not — see `employees/import/employee-import.processor.ts`)
 * — the SAME constraint 0.7's `WorkflowEscalationService` and 0.8's
 * `NotificationLocaleResolverService` already document for themselves.
 */
@Injectable()
export class EmployeeService {
  constructor(
    private readonly encryption: EncryptionService,
    private readonly customFieldValues: CustomFieldValueService,
    private readonly mapper: EmployeeMapper,
  ) {}

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CreateEmployeeInput,
    allowedBranchIds: string[] | null,
  ): Promise<EmployeeResponseDto> {
    this.assertBranchAllowed(input.branchId, allowedBranchIds);
    await this.assertReferencesExist(tx, input, null);
    await this.assertStatutoryFieldsSatisfied(tx, tenantId, input.branchId, input.statutoryFields ?? {});

    const row = await tx.employee.create({
      data: {
        tenantId,
        employeeCode: input.employeeCode,
        userId: input.userId ?? null,
        firstName: input.firstName,
        lastName: input.lastName,
        personalEmail: input.personalEmail ?? null,
        phone: input.phone ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        gender: input.gender ?? null,
        branchId: input.branchId,
        departmentId: input.departmentId ?? null,
        designationId: input.designationId ?? null,
        employmentType: input.employmentType,
        joinDate: input.joinDate,
        status: input.status ?? 'ACTIVE',
        managerId: input.managerId ?? null,
        statutoryFields: (input.statutoryFields ?? {}) as Prisma.InputJsonValue,
        ...this.encryptBankAndCompensation(input),
      },
    });

    if (input.dependents) {
      await this.replaceDependents(tx, tenantId, row.id, input.dependents);
    }
    if (input.emergencyContacts) {
      await this.replaceEmergencyContacts(tx, tenantId, row.id, input.emergencyContacts);
    }
    await this.customFieldValues.setValues(tx, tenantId, EMPLOYEE_ENTITY_TYPE, row.id, input.customFields ?? {});

    return this.mapper.toDto(tx, row);
  }

  async update(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    input: UpdateEmployeeInput,
    allowedBranchIds: string[] | null,
  ): Promise<EmployeeResponseDto> {
    const existing = await this.requireEmployee(tx, id, allowedBranchIds);

    const nextBranchId = input.branchId ?? existing.branchId;
    if (input.branchId) {
      this.assertBranchAllowed(input.branchId, allowedBranchIds);
    }
    await this.assertReferencesExist(tx, { ...input, branchId: nextBranchId }, id);

    if (input.branchId !== undefined || input.statutoryFields !== undefined) {
      const nextStatutoryFields = {
        ...((existing.statutoryFields as Record<string, string>) ?? {}),
        ...(input.statutoryFields ?? {}),
      };
      await this.assertStatutoryFieldsSatisfied(tx, tenantId, nextBranchId, nextStatutoryFields);
    }

    // Analytics dashboard (step 1.5) leaver/attrition KPIs need a real
    // termination DATE — see docs/conventions/analytics-dashboard.md.
    // Captured here, narrowly, on the status transition itself: `new
    // Date()` the moment status moves INTO TERMINATED from something else,
    // cleared back to null on a reactivation OUT of TERMINATED — a small,
    // additive seam column, same pattern as Branch.geofenceLat/
    // User.pushToken, not a leave/payroll pro-ration change.
    const terminatedAtPatch =
      input.status !== undefined && input.status !== existing.status
        ? input.status === 'TERMINATED'
          ? { terminatedAt: new Date() }
          : existing.status === 'TERMINATED'
            ? { terminatedAt: null }
            : {}
        : {};

    const row = await tx.employee.update({
      where: { id },
      data: {
        ...(input.userId !== undefined && { userId: input.userId }),
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.personalEmail !== undefined && { personalEmail: input.personalEmail }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.dateOfBirth !== undefined && { dateOfBirth: input.dateOfBirth }),
        ...(input.gender !== undefined && { gender: input.gender }),
        ...(input.branchId !== undefined && { branchId: input.branchId }),
        ...(input.departmentId !== undefined && { departmentId: input.departmentId }),
        ...(input.designationId !== undefined && { designationId: input.designationId }),
        ...(input.employmentType !== undefined && { employmentType: input.employmentType }),
        ...(input.joinDate !== undefined && { joinDate: input.joinDate }),
        ...(input.status !== undefined && { status: input.status }),
        ...terminatedAtPatch,
        ...(input.managerId !== undefined && { managerId: input.managerId }),
        ...(input.statutoryFields !== undefined && {
          statutoryFields: {
            ...((existing.statutoryFields as Record<string, string>) ?? {}),
            ...input.statutoryFields,
          } as Prisma.InputJsonValue,
        }),
        ...this.encryptBankAndCompensation(input),
      },
    });

    if (input.dependents) {
      await this.replaceDependents(tx, tenantId, id, input.dependents);
    }
    if (input.emergencyContacts) {
      await this.replaceEmergencyContacts(tx, tenantId, id, input.emergencyContacts);
    }
    if (input.customFields) {
      await this.customFieldValues.setValues(tx, tenantId, EMPLOYEE_ENTITY_TYPE, id, input.customFields);
    }

    return this.mapper.toDto(tx, row);
  }

  async findById(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
  ): Promise<EmployeeResponseDto> {
    const row = await this.requireEmployee(tx, id, allowedBranchIds);
    return this.mapper.toDto(tx, row);
  }

  /**
   * Resolves the CALLER's own linked Employee record — the one lookup no
   * existing route could answer (`GET /employees` has no `userId` filter,
   * and there's no employeeId until this resolves it), needed for step
   * 1.4's ESS "view own profile" screen. Deliberately bypasses branch
   * scoping (`allowedBranchIds: null` on the delegated `findById` call): a
   * branch-restricted caller can always see their OWN record regardless of
   * which branch it's in — the same "your own data is never out of scope"
   * posture `LeaveService`/`AttendanceClockService` already take when an
   * employeeId is omitted from a self-service request.
   */
  async findOwn(tx: Prisma.TransactionClient, userId: string): Promise<EmployeeResponseDto> {
    const employee = await tx.employee.findFirst({ where: { userId } });
    if (!employee) {
      throw new NotFoundException('No employee profile is linked to your account.');
    }
    return this.findById(tx, employee.id, null);
  }

  async list(
    tx: Prisma.TransactionClient,
    filters: EmployeeListFilters,
    allowedBranchIds: string[] | null,
  ): Promise<EmployeeListResult> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.EmployeeWhereInput = {};
    if (filters.status) {
      where.status = filters.status as Employee['status'];
    }
    if (filters.departmentId) {
      where.departmentId = filters.departmentId;
    }
    const branchFilter = this.effectiveBranchFilter(filters.branchId, allowedBranchIds);
    if (branchFilter === 'NONE') {
      return { data: [], total: 0, page, pageSize };
    }
    if (branchFilter) {
      where.branchId = branchFilter.length === 1 ? branchFilter[0] : { in: branchFilter };
    }
    if (filters.search) {
      where.OR = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { employeeCode: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      tx.employee.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.employee.count({ where }),
    ]);

    const data = await Promise.all(rows.map((row) => this.mapper.toDto(tx, row)));
    return { data, total, page, pageSize };
  }

  private async requireEmployee(
    tx: Prisma.TransactionClient,
    id: string,
    allowedBranchIds: string[] | null,
  ): Promise<Employee> {
    const row = await tx.employee.findUnique({ where: { id } });
    if (!row || (allowedBranchIds && !allowedBranchIds.includes(row.branchId))) {
      throw new NotFoundException(`Employee "${id}" was not found.`);
    }
    return row;
  }

  private assertBranchAllowed(branchId: string, allowedBranchIds: string[] | null): void {
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      throw new ForbiddenException(`You are not permitted to manage employees in branch "${branchId}".`);
    }
  }

  /** `null` = every branch (unrestricted caller, no explicit `branchId` filter); `'NONE'` = the filter and the caller's allowed set don't intersect at all, i.e. an empty result, not an error. */
  private effectiveBranchFilter(
    requestedBranchId: string | undefined,
    allowedBranchIds: string[] | null,
  ): string[] | 'NONE' | null {
    if (requestedBranchId) {
      if (allowedBranchIds && !allowedBranchIds.includes(requestedBranchId)) {
        return 'NONE';
      }
      return [requestedBranchId];
    }
    return allowedBranchIds;
  }

  private async assertReferencesExist(
    tx: Prisma.TransactionClient,
    input: Pick<CreateEmployeeInput, 'branchId' | 'departmentId' | 'designationId' | 'managerId' | 'userId'>,
    /** The employee being updated, if any — excluded from the "userId already linked" check below so re-sending a userId already linked to THIS employee doesn't falsely conflict with itself. `null` on create (nothing to exclude). */
    excludeEmployeeId: string | null,
  ): Promise<void> {
    if (input.branchId) {
      const branch = await tx.branch.findUnique({ where: { id: input.branchId }, select: { id: true } });
      if (!branch) {
        throw new BadRequestException(`branchId "${input.branchId}" was not found.`);
      }
    }
    if (input.departmentId) {
      const department = await tx.department.findUnique({ where: { id: input.departmentId }, select: { id: true } });
      if (!department) {
        throw new BadRequestException(`departmentId "${input.departmentId}" was not found.`);
      }
    }
    if (input.designationId) {
      const designation = await tx.designation.findUnique({ where: { id: input.designationId }, select: { id: true } });
      if (!designation) {
        throw new BadRequestException(`designationId "${input.designationId}" was not found.`);
      }
    }
    if (input.managerId) {
      const manager = await tx.employee.findUnique({ where: { id: input.managerId }, select: { id: true } });
      if (!manager) {
        throw new BadRequestException(`managerId "${input.managerId}" was not found.`);
      }
    }
    if (input.userId) {
      const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) {
        throw new BadRequestException(`userId "${input.userId}" was not found.`);
      }
      const linkedEmployee = await tx.employee.findFirst({ where: { userId: input.userId }, select: { id: true } });
      if (linkedEmployee && linkedEmployee.id !== excludeEmployeeId) {
        throw new BadRequestException(`userId "${input.userId}" is already linked to another employee.`);
      }
    }
    if (input.managerId && input.managerId === excludeEmployeeId) {
      throw new BadRequestException('An employee cannot be their own manager.');
    }
  }

  /**
   * Reads which statutory fields the effective Country Pack for `branchId`
   * currently requires — see docs/conventions/country-packs.md — and 400s
   * listing whichever of them `statutoryFields` is missing or blank. THE
   * RULE this enforces: which fields are required is entirely DATA (this
   * branch's resolved pack), never hardcoded here — the exact same code
   * path runs for a US branch (SSN/W4) and a QA branch (QATAR_ID/
   * VISA_SPONSORSHIP).
   */
  private async assertStatutoryFieldsSatisfied(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    statutoryFields: Record<string, string>,
  ): Promise<void> {
    const required = await resolveRequiredEmployeeFields(tx, tenantId, branchId);
    const missing = required.filter((key) => !statutoryFields[key] || statutoryFields[key].trim().length === 0);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required statutory field(s) for this employee's country: ${missing.join(', ')}.`,
      );
    }
  }

  private encryptBankAndCompensation(
    input: Pick<CreateEmployeeInput, 'bankDetails' | 'compensation'>,
  ): EncryptedBankAndCompensationFields {
    const data: EncryptedBankAndCompensationFields = {};
    if (input.bankDetails !== undefined) {
      data.bankAccountNumberEncrypted = this.encryption.encryptOptional(input.bankDetails?.accountNumber);
      data.bankNameEncrypted = this.encryption.encryptOptional(input.bankDetails?.bankName);
      data.bankRoutingCodeEncrypted = this.encryption.encryptOptional(input.bankDetails?.routingCode);
    }
    if (input.compensation !== undefined) {
      data.baseSalaryEncrypted = input.compensation ? this.encryption.encrypt(String(input.compensation.baseSalary)) : null;
      data.salaryCurrency = input.compensation?.salaryCurrency ?? null;
    }
    return data;
  }

  private async replaceDependents(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    dependents: CreateEmployeeInput['dependents'],
  ): Promise<void> {
    await tx.employeeDependent.deleteMany({ where: { employeeId } });
    if (!dependents || dependents.length === 0) {
      return;
    }
    await tx.employeeDependent.createMany({
      data: dependents.map((dependent) => ({
        tenantId,
        employeeId,
        name: dependent.name,
        relationship: dependent.relationship,
        dateOfBirth: dependent.dateOfBirth ?? null,
      })),
    });
  }

  private async replaceEmergencyContacts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    emergencyContacts: CreateEmployeeInput['emergencyContacts'],
  ): Promise<void> {
    await tx.employeeEmergencyContact.deleteMany({ where: { employeeId } });
    if (!emergencyContacts || emergencyContacts.length === 0) {
      return;
    }
    await tx.employeeEmergencyContact.createMany({
      data: emergencyContacts.map((contact) => ({
        tenantId,
        employeeId,
        name: contact.name,
        relationship: contact.relationship,
        phone: contact.phone,
      })),
    });
  }
}
