import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@hrm/db';
import { GiveRecognitionInput, LeaderboardQuery } from '@hrm/shared';
import { ENGAGEMENT_EVENTS } from './engagement.constants';
import { employeeNames, findCallerEmployee, fullName, parseDate, utcDate } from './engagement-people.util';
import { RecognitionCategoryService } from './recognition-category.service';
import type { EngagementActor } from './engagement.types';

const DAY_MS = 86_400_000;

/**
 * Recognition (kudos) — see docs/conventions/engagement-culture.md. Giving is one transaction:
 * the recognition + one `RecognitionRecipient` row per person (the points snapshot), an atomic
 * increment of each recipient's `RecognitionBalance` (the running tally), and — when PUBLIC —
 * the mirrored feed post. Recipients are notified through the 0.8 hub via a domain event.
 *
 * PRIVACY: a PRIVATE recognition is visible only to its giver and recipients. It is therefore
 * excluded from the leaderboard and from anyone else's view of a profile; the all-time
 * `RecognitionBalance` (which includes private points) is shown only to its owner.
 */
@Injectable()
export class RecognitionService {
  constructor(
    private readonly categories: RecognitionCategoryService,
    private readonly events: EventEmitter2,
  ) {}

  async give(tx: Prisma.TransactionClient, actor: EngagementActor, input: GiveRecognitionInput) {
    const giver = await findCallerEmployee(tx, actor.tenantId, actor.userId);
    if (!giver) {
      throw new ForbiddenException('You need an employee profile to give recognition.');
    }
    const category = await this.categories.requireById(tx, actor.tenantId, input.categoryId);
    if (!category.isActive) {
      throw new BadRequestException('That recognition category is no longer active.');
    }

    const recipientIds = [...new Set(input.recipientEmployeeIds)];
    if (recipientIds.includes(giver.id)) {
      throw new BadRequestException('You cannot recognize yourself.');
    }
    const recipients = await tx.employee.findMany({
      where: { tenantId: actor.tenantId, id: { in: recipientIds }, status: 'ACTIVE' },
      select: { id: true, userId: true, branchId: true, firstName: true, lastName: true },
    });
    // Out-of-scope / inactive / foreign ids are all the same 404 — never a hint which.
    const visible = recipients.filter((r) => !actor.branchIds || actor.branchIds.includes(r.branchId));
    if (visible.length !== recipientIds.length) {
      throw new NotFoundException('One or more recipients were not found.');
    }

    const recognition = await tx.recognition.create({
      data: {
        tenantId: actor.tenantId,
        giverEmployeeId: giver.id,
        categoryId: category.id,
        message: input.message,
        visibility: input.visibility,
      },
    });
    await tx.recognitionRecipient.createMany({
      data: visible.map((r) => ({
        tenantId: actor.tenantId,
        recognitionId: recognition.id,
        recipientEmployeeId: r.id,
        categoryId: category.id,
        points: category.points,
      })),
    });

    for (const r of visible) {
      await tx.recognitionBalance.upsert({
        where: { tenantId_employeeId: { tenantId: actor.tenantId, employeeId: r.id } },
        create: { tenantId: actor.tenantId, employeeId: r.id, totalPoints: category.points, receivedCount: 1 },
        update: { totalPoints: { increment: category.points }, receivedCount: { increment: 1 } },
      });
    }

    if (input.visibility === 'PUBLIC') {
      await tx.feedPost.create({
        data: {
          tenantId: actor.tenantId,
          type: 'RECOGNITION',
          scopeType: 'ORG',
          authorUserId: actor.userId,
          body: input.message,
          recognitionId: recognition.id,
        },
      });
    }

    for (const r of visible) {
      if (!r.userId) continue;
      this.events.emit(ENGAGEMENT_EVENTS.RECOGNITION_RECEIVED, {
        type: ENGAGEMENT_EVENTS.RECOGNITION_RECEIVED,
        tenantId: actor.tenantId,
        recognitionId: recognition.id,
        recipientUserId: r.userId,
        giverName: fullName(giver),
        categoryName: category.name,
        points: category.points,
        message: input.message.length > 160 ? `${input.message.slice(0, 157)}…` : input.message,
      });
    }

    return this.toView(tx, actor.tenantId, [recognition.id]).then((v) => v[0]);
  }

  /** Recognition the caller RECEIVED (public + private — it is theirs), newest first. */
  async listReceived(tx: Prisma.TransactionClient, actor: EngagementActor, limit = 50) {
    const me = await findCallerEmployee(tx, actor.tenantId, actor.userId);
    if (!me) return [];
    const rows = await tx.recognitionRecipient.findMany({
      where: { tenantId: actor.tenantId, recipientEmployeeId: me.id, removedAt: null },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      select: { recognitionId: true },
    });
    return this.toView(tx, actor.tenantId, rows.map((r) => r.recognitionId));
  }

  /** Recognition the caller GAVE, newest first. */
  async listGiven(tx: Prisma.TransactionClient, actor: EngagementActor, limit = 50) {
    const me = await findCallerEmployee(tx, actor.tenantId, actor.userId);
    if (!me) return [];
    const rows = await tx.recognition.findMany({
      where: { tenantId: actor.tenantId, giverEmployeeId: me.id, removedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true },
    });
    return this.toView(tx, actor.tenantId, rows.map((r) => r.id));
  }

  /**
   * A person's recognition profile. Your OWN profile includes private recognition and the
   * all-time balance; anyone else's is public-only, and out-of-branch-scope people are a 404.
   */
  async profile(tx: Prisma.TransactionClient, actor: EngagementActor, employeeId: string) {
    const employee = await tx.employee.findFirst({
      where: { tenantId: actor.tenantId, id: employeeId },
      select: { id: true, userId: true, branchId: true, firstName: true, lastName: true },
    });
    if (!employee || (actor.branchIds && !actor.branchIds.includes(employee.branchId) && employee.userId !== actor.userId)) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    const isSelf = employee.userId === actor.userId;
    const visibility: Prisma.RecognitionRecipientWhereInput = isSelf ? {} : { recognition: { visibility: 'PUBLIC' } };
    const base: Prisma.RecognitionRecipientWhereInput = {
      tenantId: actor.tenantId,
      recipientEmployeeId: employee.id,
      removedAt: null,
      ...visibility,
    };

    const [totals, byCategory, recent, balance] = await Promise.all([
      tx.recognitionRecipient.aggregate({ where: base, _sum: { points: true }, _count: { _all: true } }),
      tx.recognitionRecipient.groupBy({ by: ['categoryId'], where: base, _count: { _all: true }, _sum: { points: true } }),
      tx.recognitionRecipient.findMany({ where: base, orderBy: { occurredAt: 'desc' }, take: 20, select: { recognitionId: true } }),
      isSelf ? tx.recognitionBalance.findUnique({ where: { tenantId_employeeId: { tenantId: actor.tenantId, employeeId: employee.id } } }) : null,
    ]);
    const categoryRows = await tx.recognitionCategory.findMany({ where: { tenantId: actor.tenantId, id: { in: byCategory.map((c) => c.categoryId) } } });
    const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));

    return {
      employee: { id: employee.id, name: fullName(employee) },
      isSelf,
      // For yourself: the running all-time tally (incl. private). For others: public-only totals.
      totalPoints: isSelf ? (balance?.totalPoints ?? 0) : (totals._sum.points ?? 0),
      receivedCount: isSelf ? (balance?.receivedCount ?? 0) : totals._count._all,
      byCategory: byCategory
        .map((c) => ({ categoryId: c.categoryId, name: categoryName.get(c.categoryId) ?? '—', count: c._count._all, points: c._sum.points ?? 0 }))
        .sort((a, b) => b.count - a.count),
      recent: await this.toView(tx, actor.tenantId, recent.map((r) => r.recognitionId)),
    };
  }

  /**
   * Who has been recognized over a period, optionally for one category — PUBLIC recognition only
   * (see the class doc), restricted to the caller's branch scope. One indexed group-by on the
   * denormalized recipient rows, capped by `limit`; the all-time running tally lives in
   * `RecognitionBalance` for point lookups.
   */
  async leaderboard(tx: Prisma.TransactionClient, actor: EngagementActor, query: LeaderboardQuery) {
    const to = query.to ? parseDate(query.to) : utcDate();
    const from = query.from ? parseDate(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    const upper = new Date(to.getTime() + DAY_MS); // `to` is inclusive
    const where: Prisma.RecognitionRecipientWhereInput = {
      tenantId: actor.tenantId,
      removedAt: null,
      occurredAt: { gte: from, lt: upper },
      recognition: { visibility: 'PUBLIC' },
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(actor.branchIds ? { recipient: { branchId: { in: actor.branchIds } } } : {}),
    };
    const rows = await tx.recognitionRecipient.groupBy({
      by: ['recipientEmployeeId'],
      where,
      _sum: { points: true },
      _count: { _all: true },
      orderBy: [{ _sum: { points: 'desc' } }, { _count: { recipientEmployeeId: 'desc' } }],
      take: query.limit,
    });
    const names = await employeeNames(tx, actor.tenantId, rows.map((r) => r.recipientEmployeeId));
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      entries: rows.map((r, i) => ({
        rank: i + 1,
        employeeId: r.recipientEmployeeId,
        name: names.get(r.recipientEmployeeId) ?? '—',
        points: r._sum.points ?? 0,
        count: r._count._all,
      })),
    };
  }

  /** Reverses a recognition's points and hides it — called when a moderator removes its feed post. */
  async revoke(tx: Prisma.TransactionClient, tenantId: string, recognitionId: string): Promise<void> {
    const recognition = await tx.recognition.findFirst({ where: { tenantId, id: recognitionId }, include: { recipients: true } });
    if (!recognition || recognition.removedAt) return;
    const now = new Date();
    await tx.recognition.update({ where: { id: recognition.id }, data: { removedAt: now } });
    await tx.recognitionRecipient.updateMany({ where: { tenantId, recognitionId }, data: { removedAt: now } });
    for (const r of recognition.recipients) {
      await tx.recognitionBalance.updateMany({
        where: { tenantId, employeeId: r.recipientEmployeeId },
        data: { totalPoints: { decrement: r.points }, receivedCount: { decrement: 1 } },
      });
    }
  }

  /** Hydrates recognition ids into the shape the UI renders (giver, recipients, category), preserving `ids` order. */
  async toView(tx: Prisma.TransactionClient, tenantId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await tx.recognition.findMany({
      where: { tenantId, id: { in: ids } },
      include: { recipients: { select: { recipientEmployeeId: true, points: true } }, category: { select: { id: true, name: true } } },
    });
    const names = await employeeNames(tx, tenantId, rows.flatMap((r) => [r.giverEmployeeId, ...r.recipients.map((x) => x.recipientEmployeeId)]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        id: r.id,
        message: r.message,
        visibility: r.visibility,
        createdAt: r.createdAt.toISOString(),
        category: r.category,
        giver: { id: r.giverEmployeeId, name: names.get(r.giverEmployeeId) ?? '—' },
        recipients: r.recipients.map((x) => ({ id: x.recipientEmployeeId, name: names.get(x.recipientEmployeeId) ?? '—' })),
        points: r.recipients[0]?.points ?? 0,
      }));
  }
}
