import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { SubmitSurveyResponseInput } from '@hrm/shared';
import { utcDate } from './engagement-people.util';
import { effectiveSurveyState } from './survey.service';

/**
 * Submitting a survey response — THE ANONYMITY GUARANTEE lives here and in the schema
 * (docs/conventions/engagement-culture.md § Anonymity):
 *
 * - `SurveyAssignment` (who has answered) is claimed with an atomic `updateMany ... WHERE status =
 *   'PENDING'` — double-submit safe under concurrency — and records only the DATE.
 * - `SurveyResponse.respondentUserId` is written ONLY for a non-anonymous survey; for an
 *   anonymous one it is NULL, and `submittedOn` is a DATE (never a timestamp), so a response can
 *   be neither joined to a person nor lined up with an assignment by time.
 * - The counters (`SurveyTally`, `Survey.responseCount`) are incremented atomically, so results
 *   never have to scan answers.
 * - This route is deliberately NOT `@AuditLog`ged: the audit interceptor would write the actor's
 *   user id next to the request/response — exactly the link this module exists to not keep. No
 *   domain event carrying the respondent is emitted either.
 * - `hrm_app` holds only SELECT+INSERT on `survey_responses`/`survey_answers` (no UPDATE/DELETE):
 *   a stored response cannot be re-attributed after the fact through the application role.
 */
@Injectable()
export class SurveyResponseService {
  async submit(tx: Prisma.TransactionClient, tenantId: string, userId: string, surveyId: string, input: SubmitSurveyResponseInput): Promise<{ submitted: true }> {
    const assignment = await tx.surveyAssignment.findFirst({ where: { tenantId, surveyId, userId } });
    if (!assignment) throw new NotFoundException(`Survey "${surveyId}" was not found.`);
    const survey = await tx.survey.findFirst({ where: { tenantId, id: surveyId } });
    if (!survey) throw new NotFoundException(`Survey "${surveyId}" was not found.`);

    const state = effectiveSurveyState(survey);
    if (state === 'NOT_YET_OPEN') throw new ConflictException('This survey is not open yet.');
    if (state !== 'OPEN') throw new ConflictException('This survey is closed.');
    if (assignment.status === 'SUBMITTED') throw new ConflictException('You have already answered this survey.');

    const questions = await tx.surveyQuestion.findMany({ where: { tenantId, surveyId }, orderBy: { order: 'asc' } });
    const byId = new Map(questions.map((q) => [q.id, q]));
    const seen = new Set<string>();
    const rows: { questionId: string; ratingValue: number | null; optionIds: string[]; textValue: string | null }[] = [];
    const tallyBuckets: { questionId: string; bucket: string }[] = [];

    for (const answer of input.answers) {
      const q = byId.get(answer.questionId);
      if (!q) throw new BadRequestException(`Question "${answer.questionId}" does not belong to this survey.`);
      if (seen.has(q.id)) throw new BadRequestException(`Question "${q.id}" was answered twice.`);
      seen.add(q.id);

      if (q.type === 'RATING') {
        const v = answer.ratingValue;
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v < (q.scaleMin ?? 1) || v > (q.scaleMax ?? 5)) {
          throw new BadRequestException(`Rating for "${q.id}" must be between ${q.scaleMin ?? 1} and ${q.scaleMax ?? 5}.`);
        }
        rows.push({ questionId: q.id, ratingValue: v, optionIds: [], textValue: null });
        tallyBuckets.push({ questionId: q.id, bucket: String(v) });
      } else if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') {
        const chosen = [...new Set(answer.optionIds ?? [])];
        if (chosen.length === 0) continue;
        const valid = new Set(((q.options as { id: string }[] | null) ?? []).map((o) => o.id));
        if (chosen.some((id) => !valid.has(id))) throw new BadRequestException(`Unknown option for question "${q.id}".`);
        if (q.type === 'SINGLE_CHOICE' && chosen.length !== 1) throw new BadRequestException(`Question "${q.id}" takes exactly one option.`);
        rows.push({ questionId: q.id, ratingValue: null, optionIds: chosen, textValue: null });
        for (const id of chosen) tallyBuckets.push({ questionId: q.id, bucket: id });
      } else {
        const text = answer.text?.trim();
        if (!text) continue;
        rows.push({ questionId: q.id, ratingValue: null, optionIds: [], textValue: text });
      }
    }

    const missing = questions.filter((q) => q.required && !rows.some((r) => r.questionId === q.id));
    if (missing.length > 0) {
      throw new BadRequestException(`Required question(s) not answered: ${missing.map((q) => q.order).join(', ')}.`);
    }

    // Claim the assignment atomically — the loser of a concurrent double-submit gets count 0.
    const today = utcDate();
    const claimed = await tx.surveyAssignment.updateMany({
      where: { id: assignment.id, status: 'PENDING' },
      data: { status: 'SUBMITTED', submittedOn: today },
    });
    if (claimed.count !== 1) throw new ConflictException('You have already answered this survey.');

    const response = await tx.surveyResponse.create({
      data: { tenantId, surveyId, respondentUserId: survey.anonymous ? null : userId, submittedOn: today },
    });
    if (rows.length > 0) {
      await tx.surveyAnswer.createMany({ data: rows.map((r) => ({ tenantId, responseId: response.id, surveyId, ...r })) });
    }
    for (const t of tallyBuckets) {
      await tx.surveyTally.updateMany({ where: { surveyId, questionId: t.questionId, bucket: t.bucket }, data: { count: { increment: 1 } } });
    }
    await tx.survey.update({ where: { id: surveyId }, data: { responseCount: { increment: 1 } } });

    return { submitted: true };
  }
}
