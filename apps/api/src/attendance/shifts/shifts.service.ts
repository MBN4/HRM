import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, RosterAssignment, ShiftDefinition } from '@hrm/db';
import {
  createShiftDefinitionSchema,
  shiftToWorkingHours,
  type CreateRosterAssignmentInput,
  type CreateShiftDefinitionInput,
  type UpdateShiftDefinitionInput,
} from '@hrm/shared';
import { minutesFromHHmm } from '../attendance-timezone.util';

/**
 * `ShiftDefinition` CRUD + the legacy (1.3) range-based `RosterAssignment` create — see
 * docs/conventions/attendance.md. Step 8.2 extends the shift with the working-hours parameters
 * (grace / half-day / colour / coverage target) and adds update/delete/usage; the dated roster
 * CALENDAR lives in `SchedulingModule` (docs/conventions/shift-scheduling.md). No approval/workflow
 * involvement: defining shifts is an ordinary, permission-gated, audited operation.
 */
@Injectable()
export class ShiftsService {
  async createShift(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CreateShiftDefinitionInput,
  ): Promise<ShiftDefinition> {
    await this.assertNameFree(tx, input.name);
    return tx.shiftDefinition.create({
      data: {
        tenantId,
        name: input.name,
        startTime: input.startTime,
        endTime: input.endTime,
        breakMinutes: input.breakMinutes ?? 0,
        crossesMidnight: minutesFromHHmm(input.startTime) >= minutesFromHHmm(input.endTime),
        graceMinutes: input.graceMinutes ?? 15,
        halfDayThresholdHours: input.halfDayThresholdHours ?? null,
        color: input.color ?? null,
        minStaffing: input.minStaffing ?? null,
      },
    });
  }

  async updateShift(
    tx: Prisma.TransactionClient,
    id: string,
    input: UpdateShiftDefinitionInput,
  ): Promise<ShiftDefinition> {
    const existing = await tx.shiftDefinition.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Shift "${id}" was not found.`);
    const merged = {
      name: input.name ?? existing.name,
      startTime: input.startTime ?? existing.startTime,
      endTime: input.endTime ?? existing.endTime,
      breakMinutes: input.breakMinutes ?? existing.breakMinutes,
      graceMinutes: input.graceMinutes ?? existing.graceMinutes,
      halfDayThresholdHours:
        input.halfDayThresholdHours !== undefined
          ? input.halfDayThresholdHours
          : existing.halfDayThresholdHours,
      color: input.color !== undefined ? input.color : existing.color,
      minStaffing: input.minStaffing !== undefined ? input.minStaffing : existing.minStaffing,
    };
    // Re-validate the MERGED result (e.g. shortening a shift below its existing break).
    const parsed = createShiftDefinitionSchema.safeParse(merged);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    if (merged.name !== existing.name) await this.assertNameFree(tx, merged.name);
    return tx.shiftDefinition.update({
      where: { id },
      data: {
        ...merged,
        crossesMidnight: minutesFromHHmm(merged.startTime) >= minutesFromHHmm(merged.endTime),
      },
    });
  }

  /** A shift still referenced (a standing assignment, a roster row or a swap) can't be deleted — reassign first. */
  async deleteShift(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ id: string; removed: true }> {
    const existing = await tx.shiftDefinition.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Shift "${id}" was not found.`);
    const [standing, roster, swaps] = await Promise.all([
      tx.workingHoursPolicy.count({ where: { shiftDefinitionId: id } }),
      tx.rosterAssignment.count({ where: { shiftDefinitionId: id } }),
      tx.shiftSwapRequest.count({
        where: { OR: [{ requesterShiftId: id }, { counterpartShiftId: id }] },
      }),
    ]);
    if (standing + roster + swaps > 0) {
      throw new ConflictException(
        `Shift "${existing.name}" is still in use (${standing} standing assignment(s), ${roster} roster assignment(s), ${swaps} swap request(s)). Reassign them first.`,
      );
    }
    await tx.shiftDefinition.delete({ where: { id } });
    return { id, removed: true };
  }

  async listShifts(tx: Prisma.TransactionClient): Promise<ShiftDefinition[]> {
    return tx.shiftDefinition.findMany({ orderBy: { name: 'asc' } });
  }

  /** Shifts with their derived working-hours values and how widely each is used (for the admin screen). */
  async listShiftsWithUsage(tx: Prisma.TransactionClient) {
    const [shifts, standing, roster] = await Promise.all([
      tx.shiftDefinition.findMany({ orderBy: [{ startTime: 'asc' }, { name: 'asc' }] }),
      tx.workingHoursPolicy.groupBy({
        by: ['shiftDefinitionId'],
        where: { shiftDefinitionId: { not: null } },
        _count: { _all: true },
      }),
      tx.rosterAssignment.groupBy({
        by: ['shiftDefinitionId'],
        where: { shiftDefinitionId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const standingCount = new Map(standing.map((r) => [r.shiftDefinitionId, r._count._all]));
    const rosterCount = new Map(roster.map((r) => [r.shiftDefinitionId, r._count._all]));
    return shifts.map((s) => ({
      ...s,
      hours: shiftToWorkingHours(s),
      usage: { standing: standingCount.get(s.id) ?? 0, roster: rosterCount.get(s.id) ?? 0 },
    }));
  }

  /** Legacy (1.3) multi-day range assignment — a live (PUBLISHED) row. The calendar uses `RosterService` instead. */
  async createRosterAssignment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    input: CreateRosterAssignmentInput,
  ): Promise<RosterAssignment> {
    const employee = await tx.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee || (allowedBranchIds && !allowedBranchIds.includes(employee.branchId))) {
      throw new NotFoundException(`Employee "${input.employeeId}" was not found.`);
    }
    const shift = await tx.shiftDefinition.findUnique({
      where: { id: input.shiftDefinitionId },
      select: { id: true },
    });
    if (!shift) {
      throw new NotFoundException(`Shift definition "${input.shiftDefinitionId}" was not found.`);
    }

    return tx.rosterAssignment.create({
      data: {
        tenantId,
        employeeId: input.employeeId,
        shiftDefinitionId: input.shiftDefinitionId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
      },
    });
  }

  async listRosterForEmployee(
    tx: Prisma.TransactionClient,
    employeeId: string,
  ): Promise<RosterAssignment[]> {
    return tx.rosterAssignment.findMany({
      where: { employeeId },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  private async assertNameFree(tx: Prisma.TransactionClient, name: string) {
    const clash = await tx.shiftDefinition.findFirst({ where: { name }, select: { id: true } });
    if (clash) throw new ConflictException(`A shift named "${name}" already exists.`);
  }
}
