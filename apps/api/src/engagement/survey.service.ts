import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, Survey } from '@hrm/db';
import { CreateSurveyInput, SurveyQuestionInput } from '@hrm/shared';
import { ENGAGEMENT_EVENTS } from './engagement.constants';
import { SurveyAudienceService } from './survey-audience.service';
import type { EngagementActor } from './engagement.types';

/** A survey is answerable only while OPEN and inside its [opensAt, closesAt) window. */
export function effectiveSurveyState(s: Pick<Survey, 'status' | 'opensAt' | 'closesAt'>, now = new Date()): 'DRAFT' | 'NOT_YET_OPEN' | 'OPEN' | 'CLOSED' {
  if (s.status === 'DRAFT') return 'DRAFT';
  if (s.status === 'CLOSED' || (s.closesAt && s.closesAt <= now)) return 'CLOSED';
  if (s.opensAt && s.opensAt > now) return 'NOT_YET_OPEN';
  return 'OPEN';
}

function questionRows(tenantId: string, surveyId: string, questions: SurveyQuestionInput[]): Prisma.SurveyQuestionCreateManyInput[] {
  return questions.map((q, index) => ({
    tenantId,
    surveyId,
    order: index + 1,
    type: q.type,
    prompt: q.prompt,
    required: q.required,
    scaleMin: q.type === 'RATING' ? (q.scaleMin ?? 1) : null,
    scaleMax: q.type === 'RATING' ? (q.scaleMax ?? 5) : null,
    options: q.options ?? undefined,
  }));
}

/**
 * Survey authoring + lifecycle (DRAFT -> OPEN -> CLOSED) and the employee "my surveys" read — see
 * docs/conventions/engagement-culture.md. Answers and results live in
 * `SurveyResponseService` / `SurveyResultsService`.
 */
@Injectable()
export class SurveyService {
  constructor(
    private readonly audience: SurveyAudienceService,
    private readonly events: EventEmitter2,
  ) {}

  async create(tx: Prisma.TransactionClient, actor: EngagementActor, input: CreateSurveyInput) {
    const survey = await tx.survey.create({
      data: {
        tenantId: actor.tenantId,
        title: input.title,
        description: input.description,
        anonymous: input.anonymous,
        audienceType: input.audienceType,
        audienceIds: input.audienceIds,
        opensAt: input.opensAt ? new Date(input.opensAt) : null,
        closesAt: input.closesAt ? new Date(input.closesAt) : null,
        createdByUserId: actor.userId,
      },
    });
    await tx.surveyQuestion.createMany({ data: questionRows(actor.tenantId, survey.id, input.questions) });
    return this.detail(tx, actor.tenantId, survey.id);
  }

  async update(tx: Prisma.TransactionClient, actor: EngagementActor, id: string, input: CreateSurveyInput) {
    const survey = await this.requireById(tx, actor.tenantId, id);
    if (survey.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT survey can be edited — questions are frozen once it is published.');
    }
    await tx.survey.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description ?? null,
        anonymous: input.anonymous,
        audienceType: input.audienceType,
        audienceIds: input.audienceIds,
        opensAt: input.opensAt ? new Date(input.opensAt) : null,
        closesAt: input.closesAt ? new Date(input.closesAt) : null,
      },
    });
    await tx.surveyQuestion.deleteMany({ where: { tenantId: actor.tenantId, surveyId: id } });
    await tx.surveyQuestion.createMany({ data: questionRows(actor.tenantId, id, input.questions) });
    return this.detail(tx, actor.tenantId, id);
  }

  /**
   * DRAFT -> OPEN: resolves + snapshots the audience into assignments, creates the tally counters
   * (so submits are pure atomic increments), then notifies every assignee via the 0.8 hub.
   */
  async publish(tx: Prisma.TransactionClient, actor: EngagementActor, id: string) {
    const survey = await this.requireById(tx, actor.tenantId, id);
    if (survey.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT survey can be published.');
    }
    if (survey.closesAt && survey.closesAt <= new Date()) {
      throw new BadRequestException('closesAt is already in the past — edit the survey before publishing.');
    }
    const members = await this.audience.resolve(tx, actor, survey.audienceType, survey.audienceIds);
    if (members.length === 0) {
      throw new BadRequestException('The audience resolves to nobody who can answer (active employees with a login).');
    }

    const questions = await tx.surveyQuestion.findMany({ where: { tenantId: actor.tenantId, surveyId: id }, orderBy: { order: 'asc' } });
    const tallies: Prisma.SurveyTallyCreateManyInput[] = [];
    for (const q of questions) {
      if (q.type === 'RATING') {
        for (let v = q.scaleMin ?? 1; v <= (q.scaleMax ?? 5); v += 1) {
          tallies.push({ tenantId: actor.tenantId, surveyId: id, questionId: q.id, bucket: String(v), count: 0 });
        }
      } else if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') {
        for (const option of (q.options as { id: string }[] | null) ?? []) {
          tallies.push({ tenantId: actor.tenantId, surveyId: id, questionId: q.id, bucket: option.id, count: 0 });
        }
      }
    }
    await tx.surveyTally.createMany({ data: tallies });
    await tx.surveyAssignment.createMany({ data: members.map((m) => ({ tenantId: actor.tenantId, surveyId: id, userId: m.userId })) });

    const published = await tx.survey.update({
      where: { id },
      data: { status: 'OPEN', publishedAt: new Date(), assignedCount: members.length, opensAt: survey.opensAt ?? new Date() },
    });

    for (const m of members) {
      this.events.emit(ENGAGEMENT_EVENTS.SURVEY_ASSIGNED, {
        type: ENGAGEMENT_EVENTS.SURVEY_ASSIGNED,
        tenantId: actor.tenantId,
        surveyId: id,
        recipientUserId: m.userId,
        surveyTitle: published.title,
      });
    }
    return this.detail(tx, actor.tenantId, id);
  }

  async close(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const survey = await this.requireById(tx, tenantId, id);
    if (survey.status === 'DRAFT') {
      throw new ConflictException('A DRAFT survey was never opened — delete it by editing, or publish it first.');
    }
    if (survey.status === 'OPEN') {
      await tx.survey.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
    }
    return this.detail(tx, tenantId, id);
  }

  async listForAdmin(tx: Prisma.TransactionClient, actor: EngagementActor) {
    const surveys = await tx.survey.findMany({ where: { tenantId: actor.tenantId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return surveys.map((s) => this.summary(s));
  }

  async detail(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const survey = await this.requireById(tx, tenantId, id);
    const questions = await tx.surveyQuestion.findMany({ where: { tenantId, surveyId: id }, orderBy: { order: 'asc' } });
    return { ...this.summary(survey), questions: questions.map((q) => this.questionView(q)) };
  }

  /** The caller's own assignments (their inbox of surveys), newest first. Pending-and-open first. */
  async listMine(tx: Prisma.TransactionClient, tenantId: string, userId: string) {
    const assignments = await tx.surveyAssignment.findMany({ where: { tenantId, userId }, orderBy: { createdAt: 'desc' }, take: 100 });
    if (assignments.length === 0) return [];
    const surveys = await tx.survey.findMany({ where: { tenantId, id: { in: assignments.map((a) => a.surveyId) } } });
    const byId = new Map(surveys.map((s) => [s.id, s]));
    const rows = assignments
      .map((a) => {
        const s = byId.get(a.surveyId);
        if (!s) return null;
        return {
          surveyId: s.id,
          title: s.title,
          description: s.description,
          anonymous: s.anonymous,
          closesAt: s.closesAt?.toISOString() ?? null,
          state: effectiveSurveyState(s),
          status: a.status,
          submittedOn: a.submittedOn?.toISOString().slice(0, 10) ?? null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    const rank = (r: (typeof rows)[number]) => (r.status === 'PENDING' && r.state === 'OPEN' ? 0 : r.status === 'PENDING' ? 1 : 2);
    return rows.sort((a, b) => rank(a) - rank(b));
  }

  /** The survey as the assignee sees it when taking it. 404 for anyone not assigned (never a hint it exists). */
  async getForTaking(tx: Prisma.TransactionClient, tenantId: string, userId: string, id: string) {
    const assignment = await tx.surveyAssignment.findFirst({ where: { tenantId, surveyId: id, userId } });
    if (!assignment) throw new NotFoundException(`Survey "${id}" was not found.`);
    const survey = await this.requireById(tx, tenantId, id);
    const questions = await tx.surveyQuestion.findMany({ where: { tenantId, surveyId: id }, orderBy: { order: 'asc' } });
    return {
      id: survey.id,
      title: survey.title,
      description: survey.description,
      anonymous: survey.anonymous,
      closesAt: survey.closesAt?.toISOString() ?? null,
      state: effectiveSurveyState(survey),
      assignmentStatus: assignment.status,
      questions: questions.map((q) => this.questionView(q)),
    };
  }

  /** Who has / hasn't answered — IDENTIFIED surveys only; for an anonymous one it would re-identify by elimination. */
  async respondents(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const survey = await this.requireById(tx, tenantId, id);
    if (survey.anonymous) {
      throw new ForbiddenException('This survey is anonymous — respondent status is not available.');
    }
    const assignments = await tx.surveyAssignment.findMany({ where: { tenantId, surveyId: id }, orderBy: { createdAt: 'asc' }, take: 5000 });
    const employees = await tx.employee.findMany({ where: { tenantId, userId: { in: assignments.map((a) => a.userId) } }, select: { id: true, userId: true, firstName: true, lastName: true } });
    const byUser = new Map(employees.map((e) => [e.userId, e]));
    return assignments.map((a) => {
      const e = byUser.get(a.userId);
      return { userId: a.userId, employeeId: e?.id ?? null, name: e ? `${e.firstName} ${e.lastName}` : '—', status: a.status, submittedOn: a.submittedOn?.toISOString().slice(0, 10) ?? null };
    });
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Survey> {
    const survey = await tx.survey.findFirst({ where: { tenantId, id } });
    if (!survey) throw new NotFoundException(`Survey "${id}" was not found.`);
    return survey;
  }

  summary(s: Survey) {
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      status: s.status,
      state: effectiveSurveyState(s),
      anonymous: s.anonymous,
      audienceType: s.audienceType,
      audienceIds: s.audienceIds,
      opensAt: s.opensAt?.toISOString() ?? null,
      closesAt: s.closesAt?.toISOString() ?? null,
      publishedAt: s.publishedAt?.toISOString() ?? null,
      closedAt: s.closedAt?.toISOString() ?? null,
      assignedCount: s.assignedCount,
      responseCount: s.responseCount,
      responseRate: s.assignedCount > 0 ? Math.round((s.responseCount / s.assignedCount) * 1000) / 10 : 0,
      createdAt: s.createdAt.toISOString(),
    };
  }

  private questionView(q: { id: string; order: number; type: string; prompt: string; required: boolean; scaleMin: number | null; scaleMax: number | null; options: unknown }) {
    return { id: q.id, order: q.order, type: q.type, prompt: q.prompt, required: q.required, scaleMin: q.scaleMin, scaleMax: q.scaleMax, options: (q.options as { id: string; label: string }[] | null) ?? null };
  }
}
