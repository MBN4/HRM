import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, RosterAssignment, ShiftDefinition } from '@hrm/db';
import type { CreateRosterAssignmentInput, CreateShiftDefinitionInput } from '@hrm/shared';
import { minutesFromHHmm } from '../attendance-timezone.util';

/**
 * `ShiftDefinition`/`RosterAssignment` CRUD — deliberately thin (no
 * approval/workflow involvement; assigning a roster is an ordinary
 * `attendance.write` HR operation, not something that needs sign-off). See
 * docs/conventions/attendance.md.
 */
@Injectable()
export class ShiftsService {
  async createShift(tx: Prisma.TransactionClient, tenantId: string, input: CreateShiftDefinitionInput): Promise<ShiftDefinition> {
    const crossesMidnight = minutesFromHHmm(input.startTime) >= minutesFromHHmm(input.endTime);
    return tx.shiftDefinition.create({
      data: {
        tenantId,
        name: input.name,
        startTime: input.startTime,
        endTime: input.endTime,
        breakMinutes: input.breakMinutes ?? 0,
        crossesMidnight,
      },
    });
  }

  async listShifts(tx: Prisma.TransactionClient): Promise<ShiftDefinition[]> {
    return tx.shiftDefinition.findMany({ orderBy: { name: 'asc' } });
  }

  async createRosterAssignment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    input: CreateRosterAssignmentInput,
  ): Promise<RosterAssignment> {
    const employee = await tx.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, branchId: true } });
    if (!employee || (allowedBranchIds && !allowedBranchIds.includes(employee.branchId))) {
      throw new NotFoundException(`Employee "${input.employeeId}" was not found.`);
    }
    const shift = await tx.shiftDefinition.findUnique({ where: { id: input.shiftDefinitionId }, select: { id: true } });
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

  async listRosterForEmployee(tx: Prisma.TransactionClient, employeeId: string): Promise<RosterAssignment[]> {
    return tx.rosterAssignment.findMany({ where: { employeeId }, orderBy: { effectiveFrom: 'desc' } });
  }
}
