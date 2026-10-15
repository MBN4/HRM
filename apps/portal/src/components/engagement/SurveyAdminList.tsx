'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { closeSurvey, listSurveysAdmin, publishSurvey } from '../../lib/api/engagement';
import { formatDate, formatNumber } from '../../lib/format';
import type { SurveySummary } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { PageSpinner } from '../ui/Spinner';
import { SurveyBuilder } from './SurveyBuilder';

const STATE_TONE = { DRAFT: 'neutral', NOT_YET_OPEN: 'info', OPEN: 'success', CLOSED: 'neutral' } as const;

export function SurveyAdminList() {
  const { t, locale } = useI18n();
  const { data, loading, error, reload } = useAsync(() => listSurveysAdmin(), []);
  const [builder, setBuilder] = useState<{ id: string | null } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'publish' | 'close'; survey: SurveySummary } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (builder) {
    return (
      <SurveyBuilder
        surveyId={builder.id}
        onCancel={() => setBuilder(null)}
        onSaved={(s) => {
          setBuilder(null);
          setNotice(t('survey.admin.saved', { title: s.title }));
          reload();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>{t('survey.admin.title')}</CardTitle>
          <Button size="sm" onClick={() => setBuilder({ id: null })} data-testid="new-survey-button">
            <Plus className="h-4 w-4" aria-hidden />
            {t('survey.admin.new')}
          </Button>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : error ? (
            <Alert tone="error">{error}</Alert>
          ) : !data || data.length === 0 ? (
            <EmptyState title={t('survey.admin.empty')} />
          ) : (
            <ul className="divide-y divide-ink-100" data-testid="survey-admin-list">
              {data.map((s) => (
                <li key={s.id} data-testid="survey-admin-row" data-survey-title={s.title} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900">{s.title}</p>
                    <p className="text-xs text-ink-500">
                      {s.status === 'DRAFT'
                        ? t('survey.admin.draftHint')
                        : t('survey.admin.counts', { responses: formatNumber(s.responseCount, locale), assigned: formatNumber(s.assignedCount, locale), rate: `${formatNumber(s.responseRate, locale)}%` })}
                      {s.closesAt ? ` · ${t('survey.closesOn', { date: formatDate(s.closesAt, locale) })}` : ''}
                    </p>
                  </div>
                  <Badge tone={s.anonymous ? 'success' : 'info'}>{s.anonymous ? t('survey.badge.anonymous') : t('survey.badge.identified')}</Badge>
                  <Badge tone={STATE_TONE[s.state]}>{t(`survey.state.${s.state}`)}</Badge>
                  {s.status === 'DRAFT' && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setBuilder({ id: s.id })} data-testid="edit-survey-button">
                        {t('action.edit')}
                      </Button>
                      <Button size="sm" onClick={() => setConfirm({ kind: 'publish', survey: s })} data-testid="publish-survey-button">
                        {t('survey.admin.publish')}
                      </Button>
                    </>
                  )}
                  {s.status === 'OPEN' && (
                    <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'close', survey: s })} data-testid="close-survey-button">
                      {t('survey.admin.close')}
                    </Button>
                  )}
                  {s.status !== 'DRAFT' && (
                    <Link href={`/engagement/surveys/${s.id}`} data-testid="survey-results-link" className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm font-medium text-ink-800 shadow-card hover:bg-sand-100">
                      {t('survey.admin.results')}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'publish' ? t('survey.admin.publishTitle') : t('survey.admin.closeTitle')}
          body={confirm.kind === 'publish' ? t('survey.admin.publishBody', { title: confirm.survey.title }) : t('survey.admin.closeBody', { title: confirm.survey.title })}
          confirmLabel={confirm.kind === 'publish' ? t('survey.admin.publish') : t('survey.admin.close')}
          tone={confirm.kind === 'close' ? 'danger' : 'primary'}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === 'publish') await publishSurvey(confirm.survey.id);
            else await closeSurvey(confirm.survey.id);
            setConfirm(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
