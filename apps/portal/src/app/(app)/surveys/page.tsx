'use client';

import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAsync } from '../../../lib/useAsync';
import { listMySurveys } from '../../../lib/api/engagement';
import { formatDate } from '../../../lib/format';
import type { MySurvey } from '../../../lib/api/types';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardBody } from '../../../components/ui/Card';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

function SurveyRow({ survey }: { survey: MySurvey }) {
  const { t, locale } = useI18n();
  const actionable = survey.status === 'PENDING' && survey.state === 'OPEN';
  return (
    <li>
      <Link href={`/surveys/${survey.surveyId}`} data-testid="my-survey-row" data-state={survey.state} data-status={survey.status} className="flex flex-wrap items-center gap-3 px-5 py-4 hover:bg-sand-100">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-900">{survey.title}</p>
          {survey.description && <p className="truncate text-xs text-ink-500">{survey.description}</p>}
          <p className="mt-1 text-xs text-ink-400">
            {survey.closesAt ? t('survey.closesOn', { date: formatDate(survey.closesAt, locale) }) : t('survey.noClose')}
            {survey.submittedOn ? ` · ${t('survey.submittedOn', { date: formatDate(survey.submittedOn, locale) })}` : ''}
          </p>
        </div>
        <Badge tone={survey.anonymous ? 'success' : 'info'}>{survey.anonymous ? t('survey.badge.anonymous') : t('survey.badge.identified')}</Badge>
        {survey.status === 'SUBMITTED' ? (
          <Badge tone="success">{t('survey.status.SUBMITTED')}</Badge>
        ) : survey.state === 'OPEN' ? (
          <Badge tone="warning">{t('survey.status.PENDING')}</Badge>
        ) : (
          <Badge tone="neutral">{t(`survey.state.${survey.state}`)}</Badge>
        )}
        <span className={`text-sm font-medium ${actionable ? 'text-brand-700' : 'text-ink-500'}`}>{actionable ? t('survey.take') : t('survey.view')}</span>
      </Link>
    </li>
  );
}

export default function SurveysPage() {
  const { t } = useI18n();
  const { data, loading, error } = useAsync(() => listMySurveys(), []);
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="page-title">{t('survey.title')}</h1>
        <p className="mt-1 text-sm text-ink-500">{t('survey.subtitle')}</p>
      </div>
      {loading ? (
        <PageSpinner />
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : !data || data.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState icon={ClipboardList} title={t('survey.empty')} />
          </CardBody>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-ink-100" data-testid="my-surveys">
            {data.map((s) => (
              <SurveyRow key={s.surveyId} survey={s} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
