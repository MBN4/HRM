import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { ANONYMITY_MIN_RESPONSES } from '@hrm/shared';
import { MAX_TEXT_ANSWERS_PER_QUESTION } from './engagement.constants';
import { SurveyService } from './survey.service';

/**
 * Aggregated survey results — see docs/conventions/engagement-culture.md.
 *
 * SCALE: reads the precomputed `SurveyTally` counters (maintained atomically at submit) and
 * `Survey.responseCount`/`assignedCount` — never a scan of `survey_answers` — so a results page is
 * O(questions x options) regardless of how many people responded. Only free-text answers are read
 * from `survey_answers`, capped per question.
 *
 * ANONYMITY: results never include respondent identity (not even for identified surveys), no
 * per-branch/department breakdown is offered (re-identification by slicing), free-text answers carry
 * no timestamp and are returned in `id` order (a random UUID — not submission order), and for an
 * ANONYMOUS survey every aggregate is withheld until `ANONYMITY_MIN_RESPONSES` responses exist
 * (`suppressed: true`) so a lone respondent's answer can't be read off a "distribution of one".
 */
@Injectable()
export class SurveyResultsService {
  constructor(private readonly surveys: SurveyService) {}

  async results(tx: Prisma.TransactionClient, tenantId: string, surveyId: string) {
    const survey = await this.surveys.requireById(tx, tenantId, surveyId);
    const detail = await this.surveys.detail(tx, tenantId, surveyId);
    const suppressed = survey.anonymous && survey.responseCount < ANONYMITY_MIN_RESPONSES;

    const base = {
      survey: { ...this.surveys.summary(survey) },
      anonymityThreshold: survey.anonymous ? ANONYMITY_MIN_RESPONSES : null,
      suppressed,
    };
    if (suppressed || survey.status === 'DRAFT') {
      return { ...base, questions: detail.questions.map((q) => ({ id: q.id, order: q.order, type: q.type, prompt: q.prompt })) };
    }

    const tallies = await tx.surveyTally.findMany({ where: { tenantId, surveyId } });
    const tallyByQuestion = new Map<string, Map<string, number>>();
    for (const t of tallies) {
      const m = tallyByQuestion.get(t.questionId) ?? new Map<string, number>();
      m.set(t.bucket, t.count);
      tallyByQuestion.set(t.questionId, m);
    }

    const questions = [];
    for (const q of detail.questions) {
      const counts = tallyByQuestion.get(q.id) ?? new Map<string, number>();
      if (q.type === 'RATING') {
        const distribution = [...counts.entries()]
          .map(([value, count]) => ({ value: Number(value), count }))
          .sort((a, b) => a.value - b.value);
        const answered = distribution.reduce((s, d) => s + d.count, 0);
        const sum = distribution.reduce((s, d) => s + d.value * d.count, 0);
        questions.push({
          id: q.id, order: q.order, type: q.type, prompt: q.prompt, scaleMin: q.scaleMin, scaleMax: q.scaleMax,
          answered,
          average: answered > 0 ? Math.round((sum / answered) * 100) / 100 : null,
          distribution,
        });
      } else if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') {
        const answered = [...counts.values()].reduce((s, c) => s + c, 0);
        questions.push({
          id: q.id, order: q.order, type: q.type, prompt: q.prompt,
          // For SINGLE_CHOICE `answered` = respondents; for MULTI_CHOICE it is total selections, so percentages are of `responseCount`.
          answered,
          options: (q.options ?? []).map((o) => ({
            id: o.id, label: o.label, count: counts.get(o.id) ?? 0,
            percent: survey.responseCount > 0 ? Math.round(((counts.get(o.id) ?? 0) / survey.responseCount) * 1000) / 10 : 0,
          })),
        });
      } else {
        const rows = await tx.surveyAnswer.findMany({
          where: { tenantId, surveyId, questionId: q.id, textValue: { not: null } },
          select: { textValue: true },
          orderBy: { id: 'asc' },
          take: MAX_TEXT_ANSWERS_PER_QUESTION,
        });
        questions.push({ id: q.id, order: q.order, type: q.type, prompt: q.prompt, answered: rows.length, textAnswers: rows.map((r) => r.textValue as string) });
      }
    }
    return { ...base, questions };
  }
}
