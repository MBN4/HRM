import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, WorkingHoursScope } from '@hrm/db';
import { SchedulingActor, SchedulingScopeService } from './scheduling-scope.service';

/**
 * STANDING shift assignment (step 8.2, Part A): "Marketing works Morning", "Sales works the
 * 16:00-01:00 shift". Deliberately NOT a second precedence mechanism — it is a
 * `WorkingHoursPolicy` row (scope COMPANY / TEAM / MEMBER) whose `shiftDefinitionId` is set, so the
 * existing member > team (nearest department) > company > Country Pack resolution decides, and a
 * shift's hours are read LIVE by the resolver (editing the shift changes everyone on it).
 * Setting a standing shift replaces any custom hours on that row; the working-hours screen's PUT
 * replaces a standing shift with custom hours — one row, one meaning at a time.
 *
 * Authority: COMPANY / TEAM standing shifts are tenant-wide decisions (HR / admin / CEO); a
 * manager may set a MEMBER standing shift for a person in their own reporting chain.
 */
@Injectable()
export class StandingShiftService {
  constructor(private readonly scope: SchedulingScopeService) {}

  /** Every policy row the actor can see, flagged SHIFT (a standing assignment) or CUSTOM (plain working hours). */
  async list(tx: Prisma.TransactionClient, actor: SchedulingActor) {
    const rows = await tx.workingHoursPolicy.findMany({
      include: {
        shiftDefinition: {
          select: { id: true, name: true, startTime: true, endTime: true, color: true },
        },
        department: { select: { id: true, name: true, branchId: true } },
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            branchId: true,
            userId: true,
            managerId: true,
          },
        },
      },
      orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
    });
    const visible = rows.filter((r) => {
      if (r.scope === 'COMPANY') return true;
      const branchId = r.department?.branchId ?? r.employee?.branchId;
      return !actor.branchIds || (!!branchId && actor.branchIds.includes(branchId));
    });
    return visible.map((r) => ({
      id: r.id,
      scope: r.scope,
      kind: r.shiftDefinitionId ? ('SHIFT' as const) : ('CUSTOM' as const),
      shift: r.shiftDefinition,
      target:
        r.scope === 'TEAM' && r.department
          ? { id: r.department.id, label: r.department.name }
          : r.scope === 'MEMBER' && r.employee
            ? {
                id: r.employee.id,
                label: `${r.employee.firstName} ${r.employee.lastName}`,
                code: r.employee.employeeCode,
              }
            : null,
      updatedAt: r.updatedAt,
    }));
  }

  setCompany(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    shiftId: string,
  ) {
    if (!actor.tenantWide || actor.branchIds) {
      throw new ForbiddenException(
        'Only an unrestricted (all-branch) administrator can set the company standing shift.',
      );
    }
    return this.upsert(tx, tenantId, actor, 'COMPANY', 'company', {}, shiftId);
  }

  async setTeam(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    departmentId: string,
    shiftId: string,
  ) {
    this.requireTenantWide(actor);
    const dept = await tx.department.findUnique({
      where: { id: departmentId },
      select: { id: true, branchId: true },
    });
    if (!dept || (actor.branchIds && !actor.branchIds.includes(dept.branchId)))
      throw new NotFoundException('Department not found.');
    return this.upsert(tx, tenantId, actor, 'TEAM', departmentId, { departmentId }, shiftId);
  }

  async setMember(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    employeeId: string,
    shiftId: string,
  ) {
    await this.scope.assertCanSchedule(tx, actor, [employeeId]);
    return this.upsert(tx, tenantId, actor, 'MEMBER', employeeId, { employeeId }, shiftId);
  }

  async removeCompany(tx: Prisma.TransactionClient, actor: SchedulingActor) {
    if (!actor.tenantWide || actor.branchIds)
      throw new ForbiddenException(
        'Only an unrestricted (all-branch) administrator can clear the company standing shift.',
      );
    return this.remove(tx, 'COMPANY', 'company');
  }

  async removeTeam(tx: Prisma.TransactionClient, actor: SchedulingActor, departmentId: string) {
    this.requireTenantWide(actor);
    const dept = await tx.department.findUnique({
      where: { id: departmentId },
      select: { branchId: true },
    });
    if (!dept || (actor.branchIds && !actor.branchIds.includes(dept.branchId)))
      throw new NotFoundException('Department not found.');
    return this.remove(tx, 'TEAM', departmentId);
  }

  async removeMember(tx: Prisma.TransactionClient, actor: SchedulingActor, employeeId: string) {
    await this.scope.assertCanSchedule(tx, actor, [employeeId]);
    return this.remove(tx, 'MEMBER', employeeId);
  }

  private requireTenantWide(actor: SchedulingActor) {
    if (!actor.tenantWide)
      throw new ForbiddenException(
        'Setting a team standing shift needs tenant-wide scheduling authority (HR / admin / CEO).',
      );
  }

  private async upsert(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    scope: WorkingHoursScope,
    targetKey: string,
    target: { departmentId?: string; employeeId?: string },
    shiftId: string,
  ) {
    const shift = await tx.shiftDefinition.findUnique({
      where: { id: shiftId },
      select: { id: true, name: true },
    });
    if (!shift) throw new NotFoundException(`Shift "${shiftId}" was not found.`);
    // A shift-linked row carries NO custom hours (a DB CHECK enforces "a shift OR a full custom set").
    const data = {
      shiftDefinitionId: shiftId,
      startTime: null,
      workHours: null,
      breakHours: null,
      halfDayThresholdHours: null,
      updatedByUserId: actor.userId,
    };
    const row = await tx.workingHoursPolicy.upsert({
      where: { tenantId_scope_targetKey: { tenantId, scope, targetKey } },
      update: data,
      create: { tenantId, scope, targetKey, ...target, ...data },
    });
    return { id: row.id, scope: row.scope, shiftDefinitionId: shiftId, shiftName: shift.name };
  }

  private async remove(tx: Prisma.TransactionClient, scope: WorkingHoursScope, targetKey: string) {
    const existing = await tx.workingHoursPolicy.findFirst({ where: { scope, targetKey } });
    if (!existing) throw new NotFoundException('No standing assignment exists for that target.');
    if (!existing.shiftDefinitionId) {
      throw new ConflictException(
        'That target has custom working hours, not a standing shift — manage it on the Working hours screen.',
      );
    }
    await tx.workingHoursPolicy.delete({ where: { id: existing.id } });
    return { id: existing.id, removed: true };
  }
}
