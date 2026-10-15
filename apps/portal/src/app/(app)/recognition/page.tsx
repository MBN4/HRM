'use client';

import { useState } from 'react';
import { Award, Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { getOwnRecognitionPoints, listGivenRecognition, listReceivedRecognition, listRecognitionCategories } from '../../../lib/api/engagement';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Tabs, tabPanelProps } from '../../../components/ui/Tabs';
import { PageSpinner } from '../../../components/ui/Spinner';
import { GiveRecognitionForm } from '../../../components/engagement/GiveRecognitionForm';
import { Leaderboard } from '../../../components/engagement/Leaderboard';
import { RecognitionCard } from '../../../components/engagement/RecognitionCard';
import { RecognitionProfileModal } from '../../../components/engagement/RecognitionProfileModal';
import type { RecognitionView } from '../../../lib/api/types';

type ListTab = 'received' | 'given';

function RecognitionList({ items, loading, empty, onOpenPerson, testId }: { items: RecognitionView[] | null; loading: boolean; empty: string; onOpenPerson: (id: string) => void; testId: string }) {
  if (loading) return <PageSpinner />;
  if (!items || items.length === 0) return <EmptyState icon={Award} title={empty} />;
  return (
    <div className="divide-y divide-ink-100" data-testid={testId}>
      {items.map((r) => (
        <div key={r.id} className="py-3">
          <RecognitionCard recognition={r} onOpenPerson={onOpenPerson} />
        </div>
      ))}
    </div>
  );
}

export default function RecognitionPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canGive = can(PERMISSIONS.RECOGNITION_GIVE);
  const [giving, setGiving] = useState(false);
  const [tab, setTab] = useState<ListTab>('received');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: categories } = useAsync(() => listRecognitionCategories(), []);
  const received = useAsync(() => listReceivedRecognition(), []);
  const given = useAsync(() => listGivenRecognition(), []);
  const { data: points, reload: reloadPoints } = useAsync(() => getOwnRecognitionPoints(), []);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">{t('recognition.title')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t('recognition.subtitle')}</p>
        </div>
        {canGive && (
          <Button data-testid="give-recognition-button" onClick={() => setGiving(true)} disabled={!categories || categories.length === 0}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('recognition.give.open')}
          </Button>
        )}
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card>
            <CardHeader className="flex-wrap">
              <CardTitle>{t('recognition.myPoints')}</CardTitle>
              <div className="flex items-center gap-4 text-sm text-ink-600">
                <span>
                  <span className="text-2xl font-semibold text-ink-900" data-testid="my-points">{points?.totalPoints ?? 0}</span> {t('recognition.leaderboard.pts')}
                </span>
                {points && (
                  <Button size="sm" variant="ghost" onClick={() => setProfileId(points.employeeId)}>
                    {t('recognition.viewProfile')}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardBody>
              <Tabs
                label={t('recognition.listsLabel')}
                idPrefix="recog"
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: 'received', label: t('recognition.tab.received'), testId: 'tab-received' },
                  { value: 'given', label: t('recognition.tab.given'), testId: 'tab-given' },
                ]}
              />
              <div className="pt-3" {...tabPanelProps('recog', tab)}>
                {tab === 'received' ? (
                  <RecognitionList items={received.data} loading={received.loading} empty={t('recognition.empty.received')} onOpenPerson={setProfileId} testId="received-list" />
                ) : (
                  <RecognitionList items={given.data} loading={given.loading} empty={t('recognition.empty.given')} onOpenPerson={setProfileId} testId="given-list" />
                )}
              </div>
            </CardBody>
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Leaderboard categories={categories ?? []} onOpenPerson={setProfileId} />
        </div>
      </div>

      {giving && (
        <Modal title={t('recognition.give.open')} onClose={() => setGiving(false)}>
          <GiveRecognitionForm
            categories={categories ?? []}
            onCancel={() => setGiving(false)}
            onGiven={() => {
              setGiving(false);
              setNotice(t('recognition.give.success'));
              received.reload();
              given.reload();
              reloadPoints();
            }}
          />
        </Modal>
      )}
      {profileId && <RecognitionProfileModal employeeId={profileId} onClose={() => setProfileId(null)} />}
    </div>
  );
}
