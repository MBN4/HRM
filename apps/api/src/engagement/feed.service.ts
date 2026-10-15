import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { CreateFeedCommentInput, CreateFeedPostInput, FeedQuery, ReactInput } from '@hrm/shared';
import { findCallerEmployee, employeeNames, userNames } from './engagement-people.util';
import { RecognitionService } from './recognition.service';
import type { EngagementActor } from './engagement.types';

/**
 * The company/team feed — see docs/conventions/engagement-culture.md. Three post types share one
 * table: RECOGNITION (mirrors a PUBLIC recognition), ANNOUNCEMENT (admin-authored) and
 * CELEBRATION (derived from employee data by `CelebrationsService`).
 *
 * VISIBILITY: an ORG post is visible to everyone in the tenant (RLS bounds the tenant); a BRANCH /
 * DEPARTMENT post only to people in that branch / department. A caller holding `engagement.manage`
 * sees every scope (they must, to moderate). Reactions/comments on a post require being able to see it.
 *
 * MODERATION is a soft remove (`removedAt` + who + why), audited at the route; removing a
 * RECOGNITION post also reverses that recognition's points (`RecognitionService.revoke`).
 */
@Injectable()
export class FeedService {
  constructor(private readonly recognition: RecognitionService) {}

  async list(tx: Prisma.TransactionClient, actor: EngagementActor, query: FeedQuery) {
    const where = await this.visibleWhere(tx, actor, query.scope);
    if (query.before) where.createdAt = { lt: new Date(query.before) };
    const posts = await tx.feedPost.findMany({
      where,
      // Pinned posts lead the FIRST page only; deeper pages are strictly chronological.
      orderBy: query.before ? [{ createdAt: 'desc' }] : [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: query.limit + 1,
    });
    const page = posts.slice(0, query.limit);
    const views = await this.hydrate(tx, actor, page);
    return { posts: views, nextBefore: posts.length > query.limit ? page[page.length - 1].createdAt.toISOString() : null };
  }

  async createPost(tx: Prisma.TransactionClient, actor: EngagementActor, input: CreateFeedPostInput) {
    if (input.scopeType === 'BRANCH') {
      const branch = await tx.branch.findFirst({ where: { tenantId: actor.tenantId, id: input.scopeId }, select: { id: true } });
      if (!branch) throw new NotFoundException('Branch not found.');
      if (actor.branchIds && !actor.branchIds.includes(branch.id)) throw new NotFoundException('Branch not found.');
    } else if (input.scopeType === 'DEPARTMENT') {
      const department = await tx.department.findFirst({ where: { tenantId: actor.tenantId, id: input.scopeId }, select: { id: true, branchId: true } });
      if (!department) throw new NotFoundException('Department not found.');
      if (actor.branchIds && !actor.branchIds.includes(department.branchId)) throw new NotFoundException('Department not found.');
    } else if (actor.branchIds) {
      throw new ForbiddenException('A branch-restricted user cannot post org-wide.');
    }
    const post = await tx.feedPost.create({
      data: {
        tenantId: actor.tenantId,
        type: input.type,
        scopeType: input.scopeType,
        scopeId: input.scopeId ?? null,
        authorUserId: actor.userId,
        title: input.title,
        body: input.body,
        pinned: input.pinned,
      },
    });
    return (await this.hydrate(tx, actor, [post]))[0];
  }

  async react(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string, input: ReactInput) {
    await this.requireVisiblePost(tx, actor, postId);
    await tx.feedReaction.upsert({
      where: { postId_userId: { postId, userId: actor.userId } },
      create: { tenantId: actor.tenantId, postId, userId: actor.userId, type: input.type },
      update: { type: input.type },
    });
    return this.reactionSummary(tx, actor, postId);
  }

  async unreact(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string) {
    await this.requireVisiblePost(tx, actor, postId);
    await tx.feedReaction.deleteMany({ where: { tenantId: actor.tenantId, postId, userId: actor.userId } });
    return this.reactionSummary(tx, actor, postId);
  }

  async listComments(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string) {
    await this.requireVisiblePost(tx, actor, postId);
    const comments = await tx.feedComment.findMany({ where: { tenantId: actor.tenantId, postId, removedAt: null }, orderBy: { createdAt: 'asc' }, take: 200 });
    const names = await userNames(tx, actor.tenantId, comments.map((c) => c.authorUserId));
    return comments.map((c) => ({ id: c.id, postId: c.postId, body: c.body, createdAt: c.createdAt.toISOString(), author: { userId: c.authorUserId, name: names.get(c.authorUserId) ?? '—' }, mine: c.authorUserId === actor.userId }));
  }

  async addComment(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string, input: CreateFeedCommentInput) {
    await this.requireVisiblePost(tx, actor, postId);
    const comment = await tx.feedComment.create({ data: { tenantId: actor.tenantId, postId, authorUserId: actor.userId, body: input.body } });
    const names = await userNames(tx, actor.tenantId, [actor.userId]);
    return { id: comment.id, postId, body: comment.body, createdAt: comment.createdAt.toISOString(), author: { userId: actor.userId, name: names.get(actor.userId) ?? '—' }, mine: true };
  }

  /** Moderation: remove a post. A removed RECOGNITION post also revokes the recognition's points. */
  async removePost(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string, reason?: string) {
    const post = await tx.feedPost.findFirst({ where: { tenantId: actor.tenantId, id: postId } });
    if (!post) throw new NotFoundException(`Post "${postId}" was not found.`);
    if (post.removedAt) return { id: post.id, removed: true };
    await tx.feedPost.update({ where: { id: postId }, data: { removedAt: new Date(), removedByUserId: actor.userId, removalReason: reason ?? null } });
    if (post.recognitionId) await this.recognition.revoke(tx, actor.tenantId, post.recognitionId);
    return { id: post.id, removed: true };
  }

  /** Moderation: remove a comment. */
  async removeComment(tx: Prisma.TransactionClient, actor: EngagementActor, commentId: string) {
    const comment = await tx.feedComment.findFirst({ where: { tenantId: actor.tenantId, id: commentId } });
    if (!comment) throw new NotFoundException(`Comment "${commentId}" was not found.`);
    if (!comment.removedAt) {
      await tx.feedComment.update({ where: { id: commentId }, data: { removedAt: new Date(), removedByUserId: actor.userId } });
    }
    return { id: comment.id, removed: true };
  }

  // ---- internals -------------------------------------------------------

  private async visibleWhere(tx: Prisma.TransactionClient, actor: EngagementActor, scope: 'ALL' | 'ORG' | 'TEAM'): Promise<Prisma.FeedPostWhereInput> {
    const where: Prisma.FeedPostWhereInput = { tenantId: actor.tenantId, removedAt: null };
    const me = await findCallerEmployee(tx, actor.tenantId, actor.userId);
    const team: Prisma.FeedPostWhereInput[] = [];
    if (actor.canManage) {
      team.push({ scopeType: { in: ['BRANCH', 'DEPARTMENT'] } });
    } else {
      if (me?.branchId) team.push({ scopeType: 'BRANCH', scopeId: me.branchId });
      if (me?.departmentId) team.push({ scopeType: 'DEPARTMENT', scopeId: me.departmentId });
    }
    if (scope === 'ORG') {
      where.scopeType = 'ORG';
    } else if (scope === 'TEAM') {
      where.OR = team.length > 0 ? team : [{ id: { in: [] } }];
    } else {
      where.OR = [{ scopeType: 'ORG' }, ...team];
    }
    return where;
  }

  private async requireVisiblePost(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string) {
    const where = await this.visibleWhere(tx, actor, 'ALL');
    const post = await tx.feedPost.findFirst({ where: { AND: [where, { id: postId }] } });
    if (!post) throw new NotFoundException(`Post "${postId}" was not found.`);
    return post;
  }

  private async reactionSummary(tx: Prisma.TransactionClient, actor: EngagementActor, postId: string) {
    const grouped = await tx.feedReaction.groupBy({ by: ['type'], where: { tenantId: actor.tenantId, postId }, _count: { _all: true } });
    const mine = await tx.feedReaction.findUnique({ where: { postId_userId: { postId, userId: actor.userId } } });
    return { LIKE: grouped.find((g) => g.type === 'LIKE')?._count._all ?? 0, CELEBRATE: grouped.find((g) => g.type === 'CELEBRATE')?._count._all ?? 0, mine: mine?.type ?? null };
  }

  /** Posts -> UI view, with batched lookups (page-size bounded — never per-post queries). */
  private async hydrate(tx: Prisma.TransactionClient, actor: EngagementActor, posts: Prisma.FeedPostGetPayload<object>[]) {
    if (posts.length === 0) return [];
    const ids = posts.map((p) => p.id);
    const [reactionRows, mineRows, commentRows, recognitions, authors, subjects] = await Promise.all([
      tx.feedReaction.groupBy({ by: ['postId', 'type'], where: { tenantId: actor.tenantId, postId: { in: ids } }, _count: { _all: true } }),
      tx.feedReaction.findMany({ where: { tenantId: actor.tenantId, postId: { in: ids }, userId: actor.userId } }),
      tx.feedComment.groupBy({ by: ['postId'], where: { tenantId: actor.tenantId, postId: { in: ids }, removedAt: null }, _count: { _all: true } }),
      this.recognition.toView(tx, actor.tenantId, posts.map((p) => p.recognitionId).filter((x): x is string => !!x)),
      userNames(tx, actor.tenantId, posts.map((p) => p.authorUserId).filter((x): x is string => !!x)),
      employeeNames(tx, actor.tenantId, posts.map((p) => p.subjectEmployeeId).filter((x): x is string => !!x)),
    ]);
    const recognitionById = new Map(recognitions.map((r) => [r.id, r]));
    return posts.map((p) => ({
      id: p.id,
      type: p.type,
      scopeType: p.scopeType,
      scopeId: p.scopeId,
      title: p.title,
      body: p.body,
      pinned: p.pinned,
      createdAt: p.createdAt.toISOString(),
      author: p.authorUserId ? { userId: p.authorUserId, name: authors.get(p.authorUserId) ?? '—' } : null,
      recognition: p.recognitionId ? (recognitionById.get(p.recognitionId) ?? null) : null,
      celebration: p.celebrationKind ? { kind: p.celebrationKind, subject: p.subjectEmployeeId ? { id: p.subjectEmployeeId, name: subjects.get(p.subjectEmployeeId) ?? '—' } : null, meta: (p.meta as Record<string, unknown> | null) ?? null } : null,
      reactions: {
        LIKE: reactionRows.find((r) => r.postId === p.id && r.type === 'LIKE')?._count._all ?? 0,
        CELEBRATE: reactionRows.find((r) => r.postId === p.id && r.type === 'CELEBRATE')?._count._all ?? 0,
        mine: mineRows.find((r) => r.postId === p.id)?.type ?? null,
      },
      commentCount: commentRows.find((c) => c.postId === p.id)?._count._all ?? 0,
    }));
  }
}
