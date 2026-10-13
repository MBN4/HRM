import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, RosterAssignmentStatus } from '@hrm/db';
import { parseYmd } from './scheduling-day.util';
import { SCHEDULING_EVENTS } from './scheduling-events';

export interface CellWrite {
  employeeId: string;
  /** YYYY-MM-DD, branch-local. */
  date: string;
  /** Set = that shift; null with dayOff = a rostered day off; null without = CLEAR the cell. */
  shiftDefinitionId: string | null;
  dayOff: boolean;
  note?: string | null;
}

export interface ApplyCellsOptions {
  actorUserId: string | null;
  /** Status given to NEWLY created cells (the calendar writes DRAFT; an approved swap writes PUBLISHED). */
  newStatus: RosterAssignmentStatus;
  /** Notify the employee when a change touches an already-PUBLISHED cell (or a freshly PUBLISHED one). */
  notify: boolean;
}

export interface ApplyCellsResult {
  created: number;
  updated: number;
  cleared: number;
  unchanged: number;
  /** Employees notified of a post-publish change. */
  changeNotices: number;
}

const sameDay = (a: Date, b: Date | null) => !!b && a.getTime() === b.getTime();

/**
 * The ONE place roster cells are written (step 8.2) — used by the manager calendar
 * (`RosterService`) and by the approved-swap listener alike, so a swap can never write a roster
 * differently from a manager. No permission/scope checks here on purpose: callers own that.
 *
 * A "cell" is a SINGLE-DAY `RosterAssignment` (effectiveFrom == effectiveTo); the partial unique
 * index guarantees at most one per employee per date. Legacy multi-day range rows are never
 * touched — a one-day cell simply outranks them for that date (narrowest span wins).
 *
 * Draft vs published: new cells are DRAFT (invisible to clock-in/classification/the employee) until
 * published. Editing or clearing an ALREADY-PUBLISHED cell takes effect immediately and notifies the
 * employee (`roster.changed`) — the "changes after publish are visible/notified" rule.
 */
@Injectable()
export class RosterWriteService {
  constructor(private readonly events: EventEmitter2) {}

  async applyCells(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CellWrite[],
    opts: ApplyCellsOptions,
  ): Promise<ApplyCellsResult> {
    // Later duplicates of the same (employee, date) win.
    const cells = [...new Map(input.map((c) => [`${c.employeeId}|${c.date}`, c])).values()];
    const result: ApplyCellsResult = {
      created: 0,
      updated: 0,
      cleared: 0,
      unchanged: 0,
      changeNotices: 0,
    };
    if (cells.length === 0) return result;

    const employeeIds = [...new Set(cells.map((c) => c.employeeId))];
    const dates = [...new Set(cells.map((c) => parseYmd(c.date)))];
    const [employees, shifts, existingRows] = await Promise.all([
      tx.employee.findMany({
        where: { id: { in: employeeIds } },
        select: { id: true, userId: true },
      }),
      tx.shiftDefinition.findMany({ select: { id: true, name: true } }),
      tx.rosterAssignment.findMany({
        where: { employeeId: { in: employeeIds }, effectiveFrom: { in: dates } },
      }),
    ]);
    const userOf = new Map(employees.map((e) => [e.id, e.userId]));
    const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
    const existing = new Map(
      existingRows
        .filter((r) => sameDay(r.effectiveFrom, r.effectiveTo))
        .map((r) => [`${r.employeeId}|${r.effectiveFrom.toISOString().slice(0, 10)}`, r]),
    );

    const toCreate: Prisma.RosterAssignmentCreateManyInput[] = [];
    const label = (shiftId: string | null, dayOff: boolean) =>
      dayOff ? 'DAY_OFF' : shiftId ? (shiftName.get(shiftId) ?? null) : null;
    const notices: { employeeId: string; date: string; from: string | null; to: string | null }[] =
      [];
    const now = new Date();

    for (const c of cells) {
      const key = `${c.employeeId}|${c.date}`;
      const row = existing.get(key);
      const isClear = !c.dayOff && !c.shiftDefinitionId;

      if (isClear) {
        if (!row) {
          result.unchanged += 1;
          continue;
        }
        await tx.rosterAssignment.delete({ where: { id: row.id } });
        result.cleared += 1;
        if (row.status === 'PUBLISHED')
          notices.push({
            employeeId: c.employeeId,
            date: c.date,
            from: label(row.shiftDefinitionId, row.dayOff),
            to: null,
          });
        continue;
      }

      if (!row) {
        toCreate.push({
          tenantId,
          employeeId: c.employeeId,
          shiftDefinitionId: c.dayOff ? null : c.shiftDefinitionId,
          dayOff: c.dayOff,
          effectiveFrom: parseYmd(c.date),
          effectiveTo: parseYmd(c.date),
          status: opts.newStatus,
          publishedAt: opts.newStatus === 'PUBLISHED' ? now : null,
          createdByUserId: opts.actorUserId,
          note: c.note ?? null,
        });
        result.created += 1;
        if (opts.newStatus === 'PUBLISHED')
          notices.push({
            employeeId: c.employeeId,
            date: c.date,
            from: null,
            to: label(c.shiftDefinitionId, c.dayOff),
          });
        continue;
      }

      // A swap/approval applying onto a still-DRAFT cell must also PUBLISH it, or the change would stay invisible.
      const publishNow = opts.newStatus === 'PUBLISHED' && row.status === 'DRAFT';
      const sameContent =
        !publishNow &&
        row.dayOff === c.dayOff &&
        row.shiftDefinitionId === (c.dayOff ? null : c.shiftDefinitionId) &&
        (c.note === undefined || row.note === (c.note ?? null));
      if (sameContent) {
        result.unchanged += 1;
        continue;
      }
      await tx.rosterAssignment.update({
        where: { id: row.id },
        data: {
          shiftDefinitionId: c.dayOff ? null : c.shiftDefinitionId,
          dayOff: c.dayOff,
          ...(c.note !== undefined ? { note: c.note } : {}),
          ...(publishNow ? { status: 'PUBLISHED' as const, publishedAt: now } : {}),
        },
      });
      result.updated += 1;
      if (row.status === 'PUBLISHED' || publishNow)
        notices.push({
          employeeId: c.employeeId,
          date: c.date,
          from: label(row.shiftDefinitionId, row.dayOff),
          to: label(c.shiftDefinitionId, c.dayOff),
        });
    }

    if (toCreate.length > 0) await tx.rosterAssignment.createMany({ data: toCreate });

    if (opts.notify) {
      for (const n of notices) {
        const employeeUserId = userOf.get(n.employeeId);
        if (!employeeUserId || n.from === n.to) continue;
        this.events.emit(SCHEDULING_EVENTS.ROSTER_CHANGED, {
          type: SCHEDULING_EVENTS.ROSTER_CHANGED,
          tenantId,
          employeeId: n.employeeId,
          employeeUserId,
          date: n.date,
          previousShift: n.from ?? '—',
          shiftName: n.to ?? '—',
        });
        result.changeNotices += 1;
      }
    }
    return result;
  }

  /** `roster.published` — one notification per affected employee with how many days were published. */
  notifyPublished(
    tenantId: string,
    recipients: {
      employeeId: string;
      employeeUserId: string;
      from: string;
      to: string;
      days: number;
    }[],
  ) {
    for (const r of recipients) {
      this.events.emit(SCHEDULING_EVENTS.ROSTER_PUBLISHED, {
        type: SCHEDULING_EVENTS.ROSTER_PUBLISHED,
        tenantId,
        ...r,
      });
    }
  }
}
