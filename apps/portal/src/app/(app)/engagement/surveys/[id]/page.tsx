'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../../i18n/I18nProvider';
import { useAuth } from '../../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../../lib/useAsync';
import { getSurveyResults, listSurveyRespondents } from '../../../../../lib/api/engagement';
import { formatDate, formatNumber } from '../../../../../lib/format';
import type { SurveyResultQuestion } from '../../../../../lib/api/types';
import { Alert } from '../../../../../components/ui/Alert';
import { Badge, StatusBadge } from '../../../../../components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../../components/ui/Card';
import { PageSpinner } from '../../../../../components/ui/Spinner';
import { KpiCard } from '../../../../../components/charts';
import { AnonymityBanner } from '../../../../../components/engagement/AnonymityBanner';

function Bar({ percent, label, detail }: { percent: number; label: string; detail: string }) {
  return (
    <li className="space-y-1" data-testid="result-bar">
      <div className="flex justify-between gap-3 text-sm">
        <span className="text-ink-800">{label}</span>
        <span className="shrink-0 text-ink-500">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden>
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
    </li>
  );
}

function QuestionResult({ q, index }: { q: SurveyResultQuestion; index: number }) {
  const { t, locale } = useI18n();
  const n = (v: number) => formatNumber(v, locale);
  return (
    <Card data-testid="question-result">
      <CardHeader>
        <CardTitle>
          {index + 1}. {q.prompt}
        </CardTitle>
        <Badge tone="neutral">{t(`survey.qtype.${q.type}`)}</Badge>
      </CardHeader>
      <CardBody className="space-y-3">
        {q.type === 'RATING' && (
          <>
            <p className="text-sm text-ink-600">
              {t('survey.results.average')}: <span className="text-2xl font-semibold text-ink-900" data-testid="rating-average">{q.average === null || q.average === undefined ? '—' : n(q.average)}</span>{' '}
              <span className="text-xs text-ink-400">({t('survey.results.answered', { count: q.answered ?? 0 })})</span>
            </p>
            <ul className="space-y-2">
              {(q.distribution ?? []).map((d) => (
                <Bar key={d.value} label={n(d.value)} percent={q.answered ? (d.count / q.answered) * 100 : 0} detail={n(d.count)} />
              ))}
            </ul>
          </>
        )}
        {(q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE') && (
          <ul className="space-y-2">
            {(q.options ?? []).map((o) => (
              <Bar key={o.id} label={o.label} percent={o.percent} detail={`${n(o.count)} · ${n(o.percent)}%`} />
            ))}
          </ul>
        )}
        {q.type === 'TEXT' &&
          ((q.textAnswers ?? []).length === 0 ? (
            <p className="text-sm text-ink-400">{t('survey.results.noText')}</p>
          ) : (
            <ul className="space-y-2" data-testid="text-answers">
              {(q.textAnswers ?? []).map((a, i) => (
                <li key={i} className="whitespace-pre-line rounded-lg bg-sand-50 px-3 py-2 text-sm text-ink-800">
                  {a}
                </li>
              ))}
            </ul>
          ))}
      </CardBody>
    </Card>
  );
}

export default function SurveyResultsPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const params = useParams<{ id: string }>();
  const canManage = can(PERMISSIONS.ENGAGEMENT_MANAGE);
  const { data, loading, error } = useAsync(() => (canManage ? getSurveyResults(params.id) : Promise.resolve(null)), [params.id, canManage]);
  const identified = !!data && !data.survey.anonymous;
  const respondents = useAsync(() => (identified ? listSurveyRespondents(params.id) : Promise.resolve(null)), [params.id, identified]);

  if (!canManage) return <Alert tone="info">{t('error.forbidden')}</Alert>;
  if (loading) return <PageSpinner />;
  if (error || !data) return <Alert tone="error">{error ?? t('error.generic')}</Alert>;

  const { survey } = data;
  const n = (v: number) => formatNumber(v, locale);
  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <Link href="/engagement" className="text-xs font-medium text-brand-700 hover:underline">← {t('survey.results.back')}</Link>
        <h1 className="page-title mt-1" data-testid="results-title">{survey.title}</h1>
        {survey.description && <p className="mt-1 text-sm text-ink-500">{survey.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={survey.status} label={t(`survey.state.${survey.state}`)} />
          {survey.closesAt && <span className="text-xs text-ink-400">{t('survey.closesOn', { date: formatDate(survey.closesAt, locale) })}</span>}
        </div>
      </div>

      <AnonymityBanner anonymous={survey.anonymous} />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label={t('survey.results.assigned')} value={n(survey.assignedCount)} testId="kpi-assigned" />
        <KpiCard label={t('survey.results.responses')} value={n(survey.responseCount)} testId="kpi-responses" index={1} />
        <KpiCard label={t('survey.results.rate')} value={`${n(survey.responseRate)}%`} testId="kpi-rate" index={2} />
      </div>

      {data.suppressed ? (
        <Alert tone="info" data-testid="results-suppressed">
          <Lock className="me-1 inline h-4 w-4" aria-hidden />
          {t('survey.results.suppressed', { threshold: data.anonymityThreshold ?? 0, count: survey.responseCount })}
        </Alert>
      ) : survey.status === 'DRAFT' ? (
        <Alert tone="info">{t('survey.results.draft')}</Alert>
      ) : (
        <div className="space-y-4">
          {data.questions.map((q, i) => (
            <QuestionResult key={q.id} q={q} index={i} />
          ))}
        </div>
      )}

      {identified && (
        <Card>
          <CardHeader>
            <CardTitle>{t('survey.results.respondents')}</CardTitle>
          </CardHeader>
          <CardBody>
            {respondents.loading ? (
              <p className="text-sm text-ink-400">{t('common.loading')}</p>
            ) : respondents.error ? (
              <Alert tone="error">{respondents.error}</Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="respondents-table">
                  <caption className="sr-only">{t('survey.results.respondents')}</caption>
                  <thead>
                    <tr className="border-b border-ink-100 text-start text-xs uppercase tracking-wide text-ink-400">
                      <th scope="col" className="py-2 pe-3 text-start font-semibold">{t('common.employee')}</th>
                      <th scope="col" className="py-2 pe-3 text-start font-semibold">{t('common.status')}</th>
                      <th scope="col" className="py-2 text-start font-semibold">{t('survey.results.submittedOn')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {(respondents.data ?? []).map((r) => (
                      <tr key={r.userId} data-testid="respondent-row">
                        <td className="py-2 pe-3 text-ink-900">{r.name}</td>
                        <td className="py-2 pe-3">
                          <StatusBadge status={r.status} label={t(`survey.status.${r.status}`)} />
                        </td>
                        <td className="py-2 text-ink-500">{r.submittedOn ? formatDate(r.submittedOn, locale) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
