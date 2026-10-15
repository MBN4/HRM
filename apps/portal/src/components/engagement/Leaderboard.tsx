'use client';

import { Trophy } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { getLeaderboard } from '../../lib/api/engagement';
import { formatNumber } from '../../lib/format';
import type { RecognitionCategory } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Field';
import { SegmentedControl } from '../ui/SegmentedControl';
import { PageSpinner } from '../ui/Spinner';
import { Avatar } from './Avatar';

type Period = '7' | '30' | '90';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function Leaderboard({ categories, onOpenPerson }: { categories: RecognitionCategory[]; onOpenPerson: (employeeId: string) => void }) {
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<Period>('30');
  const [categoryId, setCategoryId] = useState('');
  const { data, loading, error } = useAsync(() => {
    const to = new Date();
    const from = new Date(to.getTime() - Number(period) * 86_400_000);
    return getLeaderboard({ from: isoDay(from), to: isoDay(to), categoryId: categoryId || undefined, limit: 10 });
  }, [period, categoryId]);

  return (
    <Card data-testid="leaderboard">
      <CardHeader className="flex-wrap">
        <CardTitle>{t('recognition.leaderboard.title')}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label={t('recognition.leaderboard.period')}
            value={period}
            onChange={setPeriod}
            options={[
              { value: '7', label: t('recognition.leaderboard.days', { count: 7 }), testId: 'period-7' },
              { value: '30', label: t('recognition.leaderboard.days', { count: 30 }), testId: 'period-30' },
              { value: '90', label: t('recognition.leaderboard.days', { count: 90 }), testId: 'period-90' },
            ]}
          />
          <label htmlFor="leaderboard-category" className="sr-only">
            {t('recognition.leaderboard.category')}
          </label>
          <Select id="leaderboard-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} data-testid="leaderboard-category">
            <option value="">{t('recognition.leaderboard.allCategories')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardBody>
        <div aria-live="polite">
          {loading ? (
            <PageSpinner />
          ) : error || !data ? (
            <Alert tone="error">{error ?? t('error.generic')}</Alert>
          ) : data.entries.length === 0 ? (
            <EmptyState icon={Trophy} title={t('recognition.leaderboard.empty')} />
          ) : (
            <ol className="divide-y divide-ink-100">
              {data.entries.map((e) => (
                <li key={e.employeeId} data-testid="leaderboard-row" className="flex items-center gap-3 py-2.5">
                  <span className="w-6 text-sm font-semibold text-ink-400">{formatNumber(e.rank, locale)}</span>
                  <Avatar name={e.name} />
                  <button type="button" onClick={() => onOpenPerson(e.employeeId)} className="font-medium text-ink-900 underline-offset-2 hover:text-brand-700 hover:underline">
                    {e.name}
                  </button>
                  <span className="ms-auto text-sm text-ink-600">
                    <span className="font-semibold text-ink-900">{formatNumber(e.points, locale)}</span> {t('recognition.leaderboard.pts')}
                    <span className="ms-2 text-xs text-ink-400">({t('recognition.leaderboard.count', { count: e.count })})</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
