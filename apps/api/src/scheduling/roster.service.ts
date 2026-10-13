import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { CopyRosterInput, PublishRosterInput, SetRosterCellsInput } from '@hrm/shared';
import { toBranchLocal } from '../attendance/attendance-timezone.util';
import { addDaysYmd, parseYmd, ymd } from './scheduling-day.util';
import { CellWrite, RosterWriteService } from './roster-write.service';
import { SchedulingActor, SchedulingScopeService } from './scheduling-scope.service';

const MAX_COPY_CELLS = 5000;

/**
 * Scoped roster operations behind `/scheduling/roster/*` (step 8.2): set/clear cells, copy a
 * week, publish. Every method first resolves WHO the actor may schedule (branch scope, then
 * hierarchy — see `SchedulingScopeService`), then delegates the actual writes to the shared
 * `RosterWriteService`. See docs/conventions/shift-scheduling.md.
 */
@Injectable()
export class RosterService {
  constructor(
    private readonly scope: SchedulingScopeService,
    private readonly writer: RosterWriteService,
  ) {}

  async setCells(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    input: SetRosterCellsInput,
  ) {
    const employees = await this.scope.assertCanSchedule(
      tx,
      actor,
      input.cells.map((c) => c.employeeId),
    );

    const shiftIds = [
      ...new Set(input.cells.map((c) => c.shiftDefinitionId).filter((id): id is string => !!id)),
    ];
    if (shiftIds.length > 0) {
      const found = await tx.shiftDefinition.count({ where: { id: { in: shiftIds } } });
      if (found !== shiftIds.length)
        throw new NotFoundException('One or more shifts were not found.');
    }
    await this.assertNotPast(
      tx,
      actor,
      employees,
      input.cells.map((c) => ({ employeeId: c.employeeId, date: c.date })),
    );

    const writes: CellWrite[] = input.cells.map((c) => ({
      employeeId: c.employeeId,
      date: c.date,
      shiftDefinitionId: c.dayOff ? null : (c.shiftDefinitionId ?? null),
      dayOff: !!c.dayOff,
      note: c.note,
    }));
    return this.writer.applyCells(tx, tenantId, writes, {
      actorUserId: actor.userId,
      newStatus: 'DRAFT',
      notify: true,
    });
  }

  /**
   * "Copy last week": every single-day cell in [sourceFrom, sourceTo] is written onto the same
   * weekday offset from `targetFrom`, through the same write path as a manual edit (so an
   * already-published target cell stays published and notifies; a new one is DRAFT).
   */
  async copy(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    input: CopyRosterInput,
  ) {
    const people = await this.scope.listSchedulableEmployees(tx, actor, {
      departmentId: input.departmentId,
      employeeIds: input.employeeIds,
    });
    if (people.length === 0)
      return { copied: 0, created: 0, updated: 0, cleared: 0, unchanged: 0, changeNotices: 0 };

    const sourceRows = await tx.rosterAssignment.findMany({
      where: {
        employeeId: { in: people.map((p) => p.id) },
        effectiveFrom: { gte: parseYmd(input.sourceFrom), lte: parseYmd(input.sourceTo) },
      },
    });
    const offsetDays = Math.round(
      (parseYmd(input.targetFrom).getTime() - parseYmd(input.sourceFrom).getTime()) / 86_400_000,
    );
    const cells = sourceRows
      .filter(
        (r) => r.effectiveTo !== null && r.effectiveTo.getTime() === r.effectiveFrom.getTime(),
      )
      .map<CellWrite>((r) => ({
        employeeId: r.employeeId,
        date: addDaysYmd(ymd(r.effectiveFrom), offsetDays),
        shiftDefinitionId: r.shiftDefinitionId,
        dayOff: r.dayOff,
        note: r.note,
      }));
    if (cells.length > MAX_COPY_CELLS)
      throw new BadRequestException(
        `That copy would write ${cells.length} cells (max ${MAX_COPY_CELLS}); narrow it to a team.`,
      );

    await this.assertNotPast(
      tx,
      actor,
      people,
      cells.map((c) => ({ employeeId: c.employeeId, date: c.date })),
    );
    const result = await this.writer.applyCells(tx, tenantId, cells, {
      actorUserId: actor.userId,
      newStatus: 'DRAFT',
      notify: true,
    });
    return { copied: cells.length, ...result };
  }

  /** Publish every DRAFT cell in [from, to] for the people the actor may schedule; notifies each affected employee once. */
  async publish(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    input: PublishRosterInput,
  ) {
    const people = await this.scope.listSchedulableEmployees(tx, actor, {
      departmentId: input.departmentId,
      employeeIds: input.employeeIds,
    });
    if (people.length === 0) return { published: 0, employees: 0 };
    const userOf = new Map(people.map((p) => [p.id, p.userId]));

    const drafts = await tx.rosterAssignment.findMany({
      where: {
        status: 'DRAFT',
        employeeId: { in: people.map((p) => p.id) },
        effectiveFrom: { gte: parseYmd(input.from), lte: parseYmd(input.to) },
      },
      select: { id: true, employeeId: true, effectiveFrom: true },
    });
    if (drafts.length === 0) return { published: 0, employees: 0 };

    await tx.rosterAssignment.updateMany({
      where: { id: { in: drafts.map((d) => d.id) } },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    const perEmployee = new Map<string, string[]>();
    for (const d of drafts)
      perEmployee.set(d.employeeId, [
        ...(perEmployee.get(d.employeeId) ?? []),
        ymd(d.effectiveFrom),
      ]);
    this.writer.notifyPublished(
      tenantId,
      [...perEmployee.entries()].flatMap(([employeeId, days]) => {
        const employeeUserId = userOf.get(employeeId);
        if (!employeeUserId) return [];
        const sorted = [...days].sort();
        return [
          {
            employeeId,
            employeeUserId,
            from: sorted[0] as string,
            to: sorted[sorted.length - 1] as string,
            days: sorted.length,
          },
        ];
      }),
    );
    return { published: drafts.length, employees: perEmployee.size };
  }

  /**
   * Past days are history: changing them would silently recolour already-judged attendance
   * (classification is computed on read). Tenant-wide actors (HR / admin / CEO) may still correct
   * the past; managers may not. "Past" = before today in the EMPLOYEE'S branch timezone.
   */
  private async assertNotPast(
    tx: Prisma.TransactionClient,
    actor: SchedulingActor,
    employees: { id: string; branchId: string }[],
    cells: { employeeId: string; date: string }[],
  ) {
    if (actor.tenantWide) return;
    const branches = await tx.branch.findMany({
      where: { id: { in: [...new Set(employees.map((e) => e.branchId))] } },
      select: { id: true, timezone: true },
    });
    const tzOfBranch = new Map(branches.map((b) => [b.id, b.timezone]));
    const branchOf = new Map(employees.map((e) => [e.id, e.branchId]));
    const now = new Date();
    for (const c of cells) {
      const tz = tzOfBranch.get(branchOf.get(c.employeeId) as string) ?? 'UTC';
      const today = ymd(toBranchLocal(now, tz).calendarDate);
      if (c.date < today)
        throw new BadRequestException(
          `${c.date} is in the past — only HR/admin can change past roster days.`,
        );
    }
  }
}
