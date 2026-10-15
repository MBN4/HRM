'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Award, ClipboardList, MessageSquare, Users } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { getEngagementOverview } from '../../lib/api/engagement';
import { formatNumber } from '../../lib/format';
import { Alert } from '../ui/Alert';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { SegmentedControl } from '../ui/SegmentedControl';
import { KpiCard } from '../charts';

type Period = '7' | '30' | '90';
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function EngagementOverviewPanel() {
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<Period>('30');
  const { data, loading, error } = useAsync(() => {
    const to = new Date();
    return getEngagementOverview({ from: isoDay(new Date(to.getTime() - Number(period) * 86_400_000)), to: isoDay(to) });
  }, [period]);
  const n = (v: number | undefined) => formatNumber(v ?? 0, locale);

  return (
    <div className="space-y-5" data-testid="engagement-overview">
      <div className="flex justify-end">
        <SegmentedControl
          label={t('recognition.leaderboard.period')}
          value={period}
          onChange={setPeriod}
          options={[
            { value: '7', label: t('recognition.leaderboard.days', { count: 7 }) },
            { value: '30', label: t('recognition.leaderboard.days', { count: 30 }) },
            { value: '90', label: t('recognition.leaderboard.days', { count: 90 }) },
          ]}
        />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label={t('engagement.overview.recognitions')} value={n(data?.recognition.received)} hint={t('engagement.overview.publicPrivate', { public: n(data?.recognition.public), private: n(data?.recognition.private) })} icon={Award} loading={loading} testId="kpi-recognitions" index={0} />
        <KpiCard label={t('engagement.overview.givers')} value={n(data?.recognition.uniqueGivers)} icon={Users} loading={loading} index={1} />
        <KpiCard label={t('engagement.overview.openSurveys')} value={n(data?.surveys.open)} hint={t('engagement.overview.draftClosed', { draft: n(data?.surveys.draft), closed: n(data?.surveys.closed) })} icon={ClipboardList} loading={loading} testId="kpi-open-surveys" index={2} />
        <KpiCard label={t('engagement.overview.feedActivity')} value={n(data?.feed.posts)} hint={t('engagement.overview.feedHint', { comments: n(data?.feed.comments), reactions: n(data?.feed.reactions) })} icon={MessageSquare} loading={loading} index={3} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('engagement.overview.topCategories')}</CardTitle>
          </CardHeader>
          <CardBody>
            {!data || data.recognition.topCategories.length === 0 ? (
              <p className="text-sm text-ink-400">{t('common.noData')}</p>
            ) : (
              <ol className="space-y-1.5 text-sm" data-testid="top-categories">
                {data.recognition.topCategories.map((c) => (
                  <li key={c.categoryId} className="flex justify-between">
                    <span className="text-ink-800">{c.name}</span>
                    <span className="text-ink-500">{n(c.count)}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('engagement.overview.topRecipients')}</CardTitle>
          </CardHeader>
          <CardBody>
            {!data || data.recognition.topRecipients.length === 0 ? (
              <p className="text-sm text-ink-400">{t('common.noData')}</p>
            ) : (
              <ol className="space-y-1.5 text-sm" data-testid="top-recipients">
                {data.recognition.topRecipients.map((r) => (
                  <li key={r.employeeId} className="flex justify-between">
                    <span className="text-ink-800">{r.name}</span>
                    <span className="text-ink-500">{n(r.points)} {t('recognition.leaderboard.pts')}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('engagement.overview.openSurveysList')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!data || data.surveys.openSurveys.length === 0 ? (
            <p className="text-sm text-ink-400">{t('engagement.overview.noOpenSurveys')}</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {data.surveys.openSurveys.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/engagement/surveys/${s.id}`} className="font-medium text-brand-700 hover:underline">
                    {s.title}
                  </Link>
                  <span className="text-ink-500">{t('survey.admin.counts', { responses: n(s.responseCount), assigned: n(s.assignedCount), rate: `${n(s.responseRate)}%` })}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
