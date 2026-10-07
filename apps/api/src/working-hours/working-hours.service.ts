import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { UpsertWorkingHoursPolicyInput, WorkingHoursScopeName } from '@hrm/shared';
import { EffectiveWorkingHours, WorkingHoursResolverService } from './working-hours-resolver.service';

export interface WorkingHoursActor {
  userId: string;
  /** null = unrestricted (no UserBranch rows). */
  branchIds: string[] | null;
}

const COMPANY_KEY = 'company';

/**
 * Admin CRUD for the three policy scopes (step 8.1) — see
 * docs/conventions/working-hours.md. Everything runs through the request's own
 * RLS-scoped `tx`; the explicit guards here are the second layer. A
 * branch-restricted caller (UserBranch rows) can't change the COMPANY default
 * and can only target teams/members inside their branch scope.
 */
@Injectable()
export class WorkingHoursService {
  constructor(private readonly resolver: WorkingHoursResolverService) {}

  async list(tx: Prisma.TransactionClient, actor: WorkingHoursActor) {
    const rows = await tx.workingHoursPolicy.findMany({
      include: {
        department: { select: { id: true, name: true, branchId: true } },
        employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, branchId: true } },
      },
      orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
    });
    const visible = rows.filter((row) => {
      if (!actor.branchIds || row.scope === 'COMPANY') return true;
      const branchId = row.department?.branchId ?? row.employee?.branchId;
      return !!branchId && actor.branchIds.includes(branchId);
    });
    return visible.map((row) => ({
      id: row.id,
      scope: row.scope,
      target:
        row.scope === 'TEAM' && row.department
          ? { id: row.department.id, label: row.department.name }
          : row.scope === 'MEMBER' && row.employee
            ? { id: row.employee.id, label: `${row.employee.firstName} ${row.employee.lastName}`, code: row.employee.employeeCode }
            : null,
      startTime: row.startTime,
      workHours: row.workHours,
      breakHours: row.breakHours,
      requiredHours: Math.round((row.workHours + row.breakHours) * 100) / 100,
      graceMinutes: row.graceMinutes,
      halfDayThresholdHours: row.halfDayThresholdHours,
      updatedAt: row.updatedAt,
    }));
  }

  /** Dropdown data for the admin UI: departments + employees the caller may target. */
  async targets(tx: Prisma.TransactionClient, actor: WorkingHoursActor) {
    const branchWhere = actor.branchIds ? { branchId: { in: actor.branchIds } } : {};
    const [departments, employees] = await Promise.all([
      tx.department.findMany({ where: branchWhere, select: { id: true, name: true, branch: { select: { name: true } } }, orderBy: { name: 'asc' }, take: 2000 }),
      tx.employee.findMany({
        where: { ...branchWhere, status: 'ACTIVE' },
        select: { id: true, employeeCode: true, firstName: true, lastName: true, departmentId: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        take: 5000,
      }),
    ]);
    return {
      departments: departments.map((d) => ({ id: d.id, name: d.name, branchName: d.branch.name })),
      employees: employees.map((e) => ({ id: e.id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, departmentId: e.departmentId })),
    };
  }

  upsertCompany(tx: Prisma.TransactionClient, tenantId: string, actor: WorkingHoursActor, input: UpsertWorkingHoursPolicyInput) {
    if (actor.branchIds) {
      throw new ForbiddenException('Only an unrestricted (all-branch) administrator can change the company default.');
    }
    return this.upsert(tx, tenantId, actor, 'COMPANY', COMPANY_KEY, {}, input);
  }

  async upsertTeam(tx: Prisma.TransactionClient, tenantId: string, actor: WorkingHoursActor, departmentId: string, input: UpsertWorkingHoursPolicyInput) {
    const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { id: true, branchId: true } });
    if (!dept) throw new NotFoundException('Department not found.');
    this.assertInScope(actor, dept.branchId);
    return this.upsert(tx, tenantId, actor, 'TEAM', departmentId, { departmentId }, input);
  }

  async upsertMember(tx: Prisma.TransactionClient, tenantId: string, actor: WorkingHoursActor, employeeId: string, input: UpsertWorkingHoursPolicyInput) {
    const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, branchId: true } });
    if (!employee) throw new NotFoundException('Employee not found.');
    this.assertInScope(actor, employee.branchId);
    return this.upsert(tx, tenantId, actor, 'MEMBER', employeeId, { employeeId }, input);
  }

  async removeTeam(tx: Prisma.TransactionClient, actor: WorkingHoursActor, departmentId: string) {
    const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { branchId: true } });
    if (!dept) throw new NotFoundException('Department not found.');
    this.assertInScope(actor, dept.branchId);
    return this.remove(tx, 'TEAM', departmentId);
  }

  async removeMember(tx: Prisma.TransactionClient, actor: WorkingHoursActor, employeeId: string) {
    const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { branchId: true } });
    if (!employee) throw new NotFoundException('Employee not found.');
    this.assertInScope(actor, employee.branchId);
    return this.remove(tx, 'MEMBER', employeeId);
  }

  /**
   * `employeeId` omitted = the caller's own linked Employee. Looking at someone
   * else requires `canViewOthers` (working_hours.manage) and branch scope.
   */
  async effective(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: WorkingHoursActor,
    canViewOthers: boolean,
    employeeId: string | undefined,
    date: string | null,
  ): Promise<EffectiveWorkingHours> {
    let targetId = employeeId;
    if (!targetId) {
      const own = await tx.employee.findFirst({ where: { userId: actor.userId }, select: { id: true } });
      if (!own) throw new NotFoundException('You have no employee profile.');
      targetId = own.id;
    } else {
      const target = await tx.employee.findUnique({ where: { id: targetId }, select: { userId: true, branchId: true } });
      if (!target) throw new NotFoundException('Employee not found.');
      if (target.userId !== actor.userId) {
        if (!canViewOthers) throw new ForbiddenException('working_hours.manage is required to view another member\'s working hours.');
        this.assertInScope(actor, target.branchId);
      }
    }
    return this.resolver.resolve(tx, tenantId, targetId, date);
  }

  // --- helpers ---------------------------------------------------------

  private async upsert(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: WorkingHoursActor,
    scope: WorkingHoursScopeName,
    targetKey: string,
    target: { departmentId?: string; employeeId?: string },
    input: UpsertWorkingHoursPolicyInput,
  ) {
    const data = {
      startTime: input.startTime,
      workHours: input.workHours,
      breakHours: input.breakHours,
      graceMinutes: input.graceMinutes,
      halfDayThresholdHours: input.halfDayThresholdHours ?? null,
      updatedByUserId: actor.userId,
    };
    const row = await tx.workingHoursPolicy.upsert({
      where: { tenantId_scope_targetKey: { tenantId, scope, targetKey } },
      update: data,
      create: { tenantId, scope, targetKey, ...target, ...data },
    });
    return { id: row.id, scope: row.scope, ...data, requiredHours: Math.round((row.workHours + row.breakHours) * 100) / 100 };
  }

  private async remove(tx: Prisma.TransactionClient, scope: WorkingHoursScopeName, targetKey: string) {
    const existing = await tx.workingHoursPolicy.findFirst({ where: { scope, targetKey } });
    if (!existing) throw new NotFoundException('No override exists for that target.');
    await tx.workingHoursPolicy.delete({ where: { id: existing.id } });
    return { id: existing.id, removed: true };
  }

  private assertInScope(actor: WorkingHoursActor, branchId: string) {
    if (actor.branchIds && !actor.branchIds.includes(branchId)) {
      throw new ForbiddenException('That target is outside your branch scope.');
    }
  }
}
