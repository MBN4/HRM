import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { OverviewQuery } from '@hrm/shared';
import { employeeNames, parseDate, utcDate } from './engagement-people.util';
import { SurveyService } from './survey.service';
import type { EngagementActor } from './engagement.types';

const DAY_MS = 86_400_000;

/**
 * The admin "engagement overview" — counts only, each one an indexed aggregate over the period
 * (`recognition_recipients(tenant, occurred_at)`, `feed_*`, `surveys(tenant, status)`); nothing
 * scans survey answers. Branch-restricted admins see recognition activity for their own branches.
 */
@Injectable()
export class EngagementOverviewService {
  constructor(private readonly surveys: SurveyService) {}

  async overview(tx: Prisma.TransactionClient, actor: EngagementActor, query: OverviewQuery) {
    const to = query.to ? parseDate(query.to) : utcDate();
    const from = query.from ? parseDate(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    const upper = new Date(to.getTime() + DAY_MS);
    const period = { gte: from, lt: upper };
    const scope: Prisma.RecognitionRecipientWhereInput = actor.branchIds ? { recipient: { branchId: { in: actor.branchIds } } } : {};
    const recipientWhere: Prisma.RecognitionRecipientWhereInput = { tenantId: actor.tenantId, removedAt: null, occurredAt: period, ...scope };

    const [recipientRows, publicCount, byCategory, givers, topRecipients, surveys, posts, comments, reactions] = await Promise.all([
      tx.recognitionRecipient.count({ where: recipientWhere }),
      tx.recognitionRecipient.count({ where: { ...recipientWhere, recognition: { visibility: 'PUBLIC' } } }),
      tx.recognitionRecipient.groupBy({ by: ['categoryId'], where: recipientWhere, _count: { _all: true }, orderBy: { _count: { categoryId: 'desc' } }, take: 5 }),
      tx.recognition.groupBy({ by: ['giverEmployeeId'], where: { tenantId: actor.tenantId, removedAt: null, createdAt: period, recipients: { some: scope } } }),
      tx.recognitionRecipient.groupBy({ by: ['recipientEmployeeId'], where: recipientWhere, _sum: { points: true }, orderBy: { _sum: { points: 'desc' } }, take: 5 }),
      tx.survey.findMany({ where: { tenantId: actor.tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      tx.feedPost.count({ where: { tenantId: actor.tenantId, createdAt: period, removedAt: null } }),
      tx.feedComment.count({ where: { tenantId: actor.tenantId, createdAt: period, removedAt: null } }),
      tx.feedReaction.count({ where: { tenantId: actor.tenantId, createdAt: period } }),
    ]);

    const categories = await tx.recognitionCategory.findMany({ where: { tenantId: actor.tenantId, id: { in: byCategory.map((c) => c.categoryId) } } });
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const names = await employeeNames(tx, actor.tenantId, topRecipients.map((t) => t.recipientEmployeeId));
    const open = surveys.filter((s) => s.status === 'OPEN');

    return {
      period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      recognition: {
        received: recipientRows,
        public: publicCount,
        private: recipientRows - publicCount,
        uniqueGivers: givers.length,
        topCategories: byCategory.map((c) => ({ categoryId: c.categoryId, name: categoryName.get(c.categoryId) ?? '—', count: c._count._all })),
        topRecipients: topRecipients.map((t) => ({ employeeId: t.recipientEmployeeId, name: names.get(t.recipientEmployeeId) ?? '—', points: t._sum.points ?? 0 })),
      },
      surveys: {
        draft: surveys.filter((s) => s.status === 'DRAFT').length,
        open: open.length,
        closed: surveys.filter((s) => s.status === 'CLOSED').length,
        openSurveys: open.slice(0, 5).map((s) => this.surveys.summary(s)),
      },
      feed: { posts, comments, reactions },
    };
  }
}
