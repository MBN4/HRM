import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Employee, Prisma, ShiftSwapRequest } from '@hrm/db';
import { SHIFT_SWAP_ENTITY_TYPE, type CreateShiftSwapInput } from '@hrm/shared';
import { resolveAttendancePackConfig } from '../attendance/attendance-country-pack.util';
import { toBranchLocal } from '../attendance/attendance-timezone.util';
import { isPublicHoliday, isWeekend } from '../attendance/summary/attendance-day-status.util';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { WorkingHoursResolverService } from '../working-hours/working-hours-resolver.service';
import { parseYmd, ymd } from './scheduling-day.util';
import { RosterWriteService } from './roster-write.service';
import { SCHEDULING_EVENTS } from './scheduling-events';
import { SchedulingActor, SchedulingScopeService } from './scheduling-scope.service';

/**
 * Shift swap / hand-off (step 8.2, optional part of Part B). One assigned day: A hands their shift
 * to colleague B (and, if B works a different shift that day, takes B's — a true trade).
 *
 *   AWAITING_PEER  --B accepts-->  PENDING_APPROVAL  --manager chain approves-->  APPROVED (roster rewritten)
 *        |  B declines -> DECLINED          |  rejected -> REJECTED   |  canceled -> CANCELED
 *
 * THE RULE (docs/conventions/workflow.md): approval is a REAL 0.7 `WorkflowInstance`
 * (entityType "ShiftSwap", the requester's MANAGER chain) — there is deliberately no approve route
 * here, and the listener only reacts to the engine's own terminal events. The colleague's consent
 * is a plain pre-step (the workflow engine models approvers, not peers). Each side's effective
 * shift is snapshotted at request time; if either changed before approval the swap is CANCELED as
 * stale rather than overwriting someone's newer roster.
 */
@Injectable()
export class ShiftSwapService {
  constructor(
    private readonly workflowEngine: WorkflowEngineService,
    private readonly workingHours: WorkingHoursResolverService,
    private readonly writer: RosterWriteService,
    private readonly scope: SchedulingScopeService,
    private readonly events: EventEmitter2,
  ) {}

  async create(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    input: CreateShiftSwapInput,
  ) {
    const requester = await tx.employee.findFirst({ where: { userId } });
    if (!requester) throw new NotFoundException('You have no employee profile.');
    const counterpart = await tx.employee.findUnique({
      where: { id: input.counterpartEmployeeId },
    });
    if (!counterpart || counterpart.status !== 'ACTIVE')
      throw new NotFoundException('That colleague was not found.');
    if (counterpart.id === requester.id)
      throw new BadRequestException('You cannot swap a shift with yourself.');
    if (!counterpart.userId)
      throw new BadRequestException('That colleague has no login, so cannot agree to a swap.');
    if (counterpart.branchId !== requester.branchId)
      throw new BadRequestException(
        'Swaps are only possible between colleagues in the same branch.',
      );

    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: requester.branchId },
      select: { timezone: true },
    });
    const today = ymd(toBranchLocal(new Date(), branch.timezone).calendarDate);
    if (input.date < today)
      throw new BadRequestException('You can only swap a shift that has not happened yet.');

    const [mine, theirs] = await Promise.all([
      this.effectiveShiftOn(tx, tenantId, requester, input.date),
      this.effectiveShiftOn(tx, tenantId, counterpart, input.date),
    ]);
    if (!mine) throw new BadRequestException(`You have no shift on ${input.date} to hand off.`);
    if (mine === theirs)
      throw new BadRequestException('You and your colleague already work the same shift that day.');

    const open = await tx.shiftSwapRequest.findFirst({
      where: {
        requesterEmployeeId: requester.id,
        date: parseYmd(input.date),
        status: { in: ['AWAITING_PEER', 'PENDING_APPROVAL'] },
      },
    });
    if (open) throw new ConflictException('You already have an open swap request for that day.');

    const row = await tx.shiftSwapRequest.create({
      data: {
        tenantId,
        requesterEmployeeId: requester.id,
        counterpartEmployeeId: counterpart.id,
        date: parseYmd(input.date),
        requesterShiftId: mine,
        counterpartShiftId: theirs,
        reason: input.reason ?? null,
      },
    });

    const shift = await tx.shiftDefinition.findUnique({
      where: { id: mine },
      select: { name: true },
    });
    this.events.emit(SCHEDULING_EVENTS.SWAP_REQUESTED, {
      type: SCHEDULING_EVENTS.SWAP_REQUESTED,
      tenantId,
      swapId: row.id,
      employeeUserId: counterpart.userId,
      requesterName: `${requester.firstName} ${requester.lastName}`,
      date: input.date,
      shiftName: shift?.name ?? '—',
    });
    return this.toDto(tx, row);
  }

  async respond(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    id: string,
    accept: boolean,
  ) {
    const row = await tx.shiftSwapRequest.findUnique({
      where: { id },
      include: { counterpart: true, requester: true },
    });
    // Not yours = not found: the colleague is the only person who may answer.
    if (!row || row.counterpart.userId !== userId)
      throw new NotFoundException(`Swap request "${id}" was not found.`);
    if (row.status !== 'AWAITING_PEER')
      throw new BadRequestException(`This swap is already ${row.status}.`);

    if (!accept) {
      const updated = await tx.shiftSwapRequest.update({
        where: { id },
        data: { status: 'DECLINED', peerRespondedAt: new Date() },
      });
      return this.toDto(tx, updated);
    }
    if (!row.requester.userId) throw new BadRequestException('The requester has no login.');

    const instance = await this.workflowEngine.startInstance(tx, tenantId, {
      requesterId: row.requester.userId,
      entityType: SHIFT_SWAP_ENTITY_TYPE,
      entityId: row.id,
      dataSnapshot: {
        employeeId: row.requesterEmployeeId,
        counterpartEmployeeId: row.counterpartEmployeeId,
        branchId: row.requester.branchId,
        departmentId: row.requester.departmentId,
        date: ymd(row.date),
      },
    });
    const updated = await tx.shiftSwapRequest.update({
      where: { id },
      data: {
        status: 'PENDING_APPROVAL',
        peerRespondedAt: new Date(),
        workflowInstanceId: instance.id,
      },
    });
    return this.toDto(tx, updated);
  }

  /** The requester withdraws. An in-flight approval is canceled through the real workflow engine. */
  async cancel(tx: Prisma.TransactionClient, tenantId: string, userId: string, id: string) {
    const row = await tx.shiftSwapRequest.findUnique({
      where: { id },
      include: { requester: true },
    });
    if (!row || row.requester.userId !== userId)
      throw new NotFoundException(`Swap request "${id}" was not found.`);
    if (row.status !== 'AWAITING_PEER' && row.status !== 'PENDING_APPROVAL')
      throw new BadRequestException(`This swap is already ${row.status}.`);
    if (row.status === 'PENDING_APPROVAL' && row.workflowInstanceId) {
      await this.workflowEngine.cancelInstance(tx, tenantId, row.workflowInstanceId, userId, false);
    }
    const updated = await tx.shiftSwapRequest.update({
      where: { id },
      data: { status: 'CANCELED', decidedAt: new Date() },
    });
    return this.toDto(tx, updated);
  }

  /** `mine` = swaps I'm party to; `team` = swaps requested by people I may schedule (scheduling.manage). */
  async list(
    tx: Prisma.TransactionClient,
    userId: string,
    scope: 'mine' | 'team',
    actor: SchedulingActor | null,
  ) {
    let where: Prisma.ShiftSwapRequestWhereInput;
    if (scope === 'team') {
      if (!actor)
        throw new ForbiddenException("scheduling.manage is required to list your team's swaps.");
      const people = await this.scope.listSchedulableEmployees(tx, actor, {});
      where = { requesterEmployeeId: { in: people.map((p) => p.id) } };
    } else {
      const own = await tx.employee.findFirst({ where: { userId }, select: { id: true } });
      if (!own) return [];
      where = { OR: [{ requesterEmployeeId: own.id }, { counterpartEmployeeId: own.id }] };
    }
    const rows = await tx.shiftSwapRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(rows.map((r) => this.toDto(tx, r)));
  }

  /**
   * Applies an APPROVED swap (called by the workflow-events listener, in its own tenant transaction).
   * Returns the final status. Stale = either side's effective shift changed since the request.
   */
  async applyApproved(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<'APPROVED' | 'CANCELED' | null> {
    const row = await tx.shiftSwapRequest.findUnique({
      where: { id },
      include: { requester: true, counterpart: true },
    });
    if (!row || row.status !== 'PENDING_APPROVAL') return null; // (re)delivered event: already applied

    const date = ymd(row.date);
    const [nowMine, nowTheirs] = await Promise.all([
      this.effectiveShiftOn(tx, tenantId, row.requester, date),
      this.effectiveShiftOn(tx, tenantId, row.counterpart, date),
    ]);
    if (nowMine !== row.requesterShiftId || nowTheirs !== row.counterpartShiftId) {
      await tx.shiftSwapRequest.update({
        where: { id },
        data: { status: 'CANCELED', decidedAt: new Date(), decisionNote: 'ROSTER_CHANGED' },
      });
      return 'CANCELED';
    }

    // Requester takes the colleague's shift (or the day off if the colleague had none); the colleague takes the requester's.
    await this.writer.applyCells(
      tx,
      tenantId,
      [
        {
          employeeId: row.requesterEmployeeId,
          date,
          shiftDefinitionId: nowTheirs,
          dayOff: nowTheirs === null,
        },
        { employeeId: row.counterpartEmployeeId, date, shiftDefinitionId: nowMine, dayOff: false },
      ],
      { actorUserId: null, newStatus: 'PUBLISHED', notify: true },
    );
    await tx.shiftSwapRequest.update({
      where: { id },
      data: { status: 'APPROVED', decidedAt: new Date() },
    });
    return 'APPROVED';
  }

  /** The shift id a person ACTUALLY works on a date: a published cell, else (on a working day) their standing shift. */
  async effectiveShiftOn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: Pick<Employee, 'id' | 'branchId'>,
    date: string,
  ): Promise<string | null> {
    const eff = await this.workingHours.resolve(tx, tenantId, employee.id, date);
    if (eff.rostered) return eff.dayOff ? null : (eff.shift?.id ?? null);
    const pack = await resolveAttendancePackConfig(tx, tenantId, employee.branchId);
    const d = parseYmd(date);
    if (isWeekend(d, pack.weekendDays) || isPublicHoliday(d, pack.publicHolidays)) return null;
    return eff.shift?.id ?? null;
  }

  private async toDto(tx: Prisma.TransactionClient, row: ShiftSwapRequest) {
    const [requester, counterpart, shifts] = await Promise.all([
      tx.employee.findUnique({
        where: { id: row.requesterEmployeeId },
        select: { id: true, firstName: true, lastName: true },
      }),
      tx.employee.findUnique({
        where: { id: row.counterpartEmployeeId },
        select: { id: true, firstName: true, lastName: true },
      }),
      tx.shiftDefinition.findMany({
        where: {
          id: {
            in: [row.requesterShiftId, row.counterpartShiftId].filter((x): x is string => !!x),
          },
        },
        select: { id: true, name: true, startTime: true, endTime: true },
      }),
    ]);
    const shiftOf = (id: string | null) => shifts.find((s) => s.id === id) ?? null;
    return {
      id: row.id,
      date: ymd(row.date),
      status: row.status,
      reason: row.reason,
      requester: requester
        ? { id: requester.id, name: `${requester.firstName} ${requester.lastName}` }
        : null,
      counterpart: counterpart
        ? { id: counterpart.id, name: `${counterpart.firstName} ${counterpart.lastName}` }
        : null,
      requesterShift: shiftOf(row.requesterShiftId),
      counterpartShift: shiftOf(row.counterpartShiftId),
      workflowInstanceId: row.workflowInstanceId,
      decisionNote: row.decisionNote,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }
}
