'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { MAX_RATING_SCALE } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAsync } from '../../../../lib/useAsync';
import { ApiError } from '../../../../lib/api/client';
import { getSurveyForTaking, submitSurveyResponse } from '../../../../lib/api/engagement';
import { formatDate } from '../../../../lib/format';
import type { SurveyAnswerInput, SurveyQuestionView } from '../../../../lib/api/types';
import { Alert } from '../../../../components/ui/Alert';
import { Button } from '../../../../components/ui/Button';
import { Card, CardBody } from '../../../../components/ui/Card';
import { Textarea } from '../../../../components/ui/Field';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { AnonymityBanner } from '../../../../components/engagement/AnonymityBanner';

interface AnswerState {
  rating?: number;
  options: string[];
  text: string;
}

function isAnswered(q: SurveyQuestionView, a: AnswerState | undefined): boolean {
  if (!a) return false;
  if (q.type === 'RATING') return a.rating !== undefined;
  if (q.type === 'TEXT') return a.text.trim().length > 0;
  return a.options.length > 0;
}

function QuestionField({ q, index, value, onChange, disabled, invalid }: { q: SurveyQuestionView; index: number; value: AnswerState; onChange: (v: AnswerState) => void; disabled: boolean; invalid: boolean }) {
  const { t } = useI18n();
  const legend = (
    <legend className="mb-2 text-sm font-medium text-ink-900">
      {index + 1}. {q.prompt}
      {q.required ? <span className="ms-1 text-coral-600" aria-label={t('survey.required')}>*</span> : <span className="ms-2 text-xs font-normal text-ink-400">({t('common.optional')})</span>}
    </legend>
  );
  let control: React.ReactNode = null;
  if (q.type === 'RATING') {
    const min = q.scaleMin ?? 1;
    const max = Math.min(q.scaleMax ?? 5, MAX_RATING_SCALE);
    const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    control = (
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={q.prompt}>
        {values.map((v) => (
          <label key={v} className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold transition-colors focus-within:ring-2 focus-within:ring-accent-500 ${value.rating === v ? 'border-primary bg-primary text-white' : 'border-ink-200 bg-surface text-ink-700 hover:bg-sand-100'}`}>
            <input type="radio" className="sr-only" name={`q-${q.id}`} value={v} checked={value.rating === v} disabled={disabled} onChange={() => onChange({ ...value, rating: v })} data-testid={`rating-${q.order}-${v}`} />
            {v}
          </label>
        ))}
      </div>
    );
  } else if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') {
    const multi = q.type === 'MULTI_CHOICE';
    control = (
      <div className="space-y-2">
        {(q.options ?? []).map((o) => {
          const checked = value.options.includes(o.id);
          return (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm text-ink-800">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={`q-${q.id}`}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange({ ...value, options: multi ? (checked ? value.options.filter((x) => x !== o.id) : [...value.options, o.id]) : [o.id] })}
              />
              {o.label}
            </label>
          );
        })}
        {multi && <p className="text-xs text-ink-400">{t('survey.multiHint')}</p>}
      </div>
    );
  } else {
    control = <Textarea aria-label={q.prompt} rows={3} maxLength={4000} value={value.text} disabled={disabled} onChange={(e) => onChange({ ...value, text: e.target.value })} />;
  }
  return (
    <fieldset className={`rounded-xl border p-4 ${invalid ? 'border-coral-200 bg-coral-50' : 'border-ink-100'}`} data-testid="survey-question">
      {legend}
      {control}
      {invalid && <p className="mt-2 text-xs text-coral-700">{t('survey.answerRequired')}</p>}
    </fieldset>
  );
}

export default function TakeSurveyPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const { data: survey, loading, error, reload } = useAsync(() => getSurveyForTaking(params.id), [params.id]);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (loading) return <PageSpinner />;
  if (error || !survey) {
    return (
      <div className="max-w-3xl space-y-4">
        <Alert tone="error">{error ?? t('error.generic')}</Alert>
        <Link href="/surveys" className="text-sm font-medium text-brand-700 hover:underline">{t('survey.backToList')}</Link>
      </div>
    );
  }

  const readOnly = survey.assignmentStatus === 'SUBMITTED' || survey.state !== 'OPEN';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!survey) return;
    const blank: AnswerState = { options: [], text: '' };
    const missingIds = new Set(survey.questions.filter((q) => q.required && !isAnswered(q, answers[q.id] ?? blank)).map((q) => q.id));
    setMissing(missingIds);
    if (missingIds.size > 0) {
      setSubmitError(t('survey.fixRequired', { count: missingIds.size }));
      return;
    }
    const payload: SurveyAnswerInput[] = [];
    for (const q of survey.questions) {
      const a = answers[q.id] ?? blank;
      if (!isAnswered(q, a)) continue;
      if (q.type === 'RATING') payload.push({ questionId: q.id, ratingValue: a.rating });
      else if (q.type === 'TEXT') payload.push({ questionId: q.id, text: a.text.trim() });
      else payload.push({ questionId: q.id, optionIds: a.options });
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitSurveyResponse(survey.id, payload);
      setDone(true);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : t('error.generic'));
      if (err instanceof ApiError && err.status === 409) reload();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/surveys" className="text-xs font-medium text-brand-700 hover:underline">← {t('survey.backToList')}</Link>
        <h1 className="page-title mt-1" data-testid="survey-title">{survey.title}</h1>
        {survey.description && <p className="mt-1 text-sm text-ink-500">{survey.description}</p>}
        {survey.closesAt && <p className="mt-1 text-xs text-ink-400">{t('survey.closesOn', { date: formatDate(survey.closesAt, locale) })}</p>}
      </div>

      <AnonymityBanner anonymous={survey.anonymous} />

      {done ? (
        <Alert tone="success" data-testid="survey-thanks">{t('survey.thanks')}</Alert>
      ) : readOnly ? (
        <Alert tone="info" data-testid="survey-readonly">
          {survey.assignmentStatus === 'SUBMITTED' ? t('survey.alreadySubmitted') : survey.state === 'CLOSED' ? t('survey.closedMsg') : t('survey.notOpenMsg')}
        </Alert>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4" data-testid="survey-form">
          {survey.questions.map((q, i) => (
            <QuestionField key={q.id} q={q} index={i} value={answers[q.id] ?? { options: [], text: '' }} onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))} disabled={submitting} invalid={missing.has(q.id)} />
          ))}
          <div aria-live="polite">{submitError && <Alert tone="error">{submitError}</Alert>}</div>
          <Card>
            <CardBody className="flex items-center justify-end gap-3">
              <Link href="/surveys" className="text-sm text-ink-600 hover:underline">{t('action.cancel')}</Link>
              <Button type="submit" loading={submitting} data-testid="submit-survey-button">{t('survey.submit')}</Button>
            </CardBody>
          </Card>
        </form>
      )}
      {done && (
        <Link href="/surveys" className="text-sm font-medium text-brand-700 hover:underline">{t('survey.backToList')}</Link>
      )}
    </div>
  );
}
