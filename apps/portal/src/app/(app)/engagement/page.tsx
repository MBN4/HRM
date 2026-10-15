'use client';

import { useState } from 'react';
import { Megaphone, PartyPopper } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { ApiError } from '../../../lib/api/client';
import { generateCelebrations } from '../../../lib/api/engagement';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Modal } from '../../../components/ui/Modal';
import { Tabs, tabPanelProps } from '../../../components/ui/Tabs';
import { AnnouncementForm } from '../../../components/engagement/AnnouncementForm';
import { CategoryAdmin } from '../../../components/engagement/CategoryAdmin';
import { EngagementOverviewPanel } from '../../../components/engagement/EngagementOverviewPanel';
import { SurveyAdminList } from '../../../components/engagement/SurveyAdminList';

type HubTab = 'overview' | 'surveys' | 'categories' | 'feed';

function FeedTools() {
  const { t } = useI18n();
  const [composing, setComposing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function generate() {
    setGenerating(true);
    setNotice(null);
    try {
      const { created } = await generateCelebrations();
      setNotice({ tone: 'success', text: t('engagement.feed.generated', { count: created }) });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : t('error.generic') });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div aria-live="polite">{notice && <Alert tone={notice.tone} data-testid="feed-tools-notice">{notice.text}</Alert>}</div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('engagement.feed.announcements')}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-500">{t('engagement.feed.announcementsHelp')}</p>
            <Button onClick={() => setComposing(true)} data-testid="hub-new-announcement">
              <Megaphone className="h-4 w-4" aria-hidden />
              {t('feed.compose.open')}
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('engagement.feed.celebrations')}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-500">{t('engagement.feed.celebrationsHelp')}</p>
            <Button variant="secondary" onClick={generate} loading={generating} data-testid="generate-celebrations-button">
              <PartyPopper className="h-4 w-4" aria-hidden />
              {t('engagement.feed.generate')}
            </Button>
          </CardBody>
        </Card>
      </div>
      <p className="text-xs text-ink-400">{t('engagement.feed.moderationHint')}</p>
      {composing && (
        <Modal title={t('feed.compose.open')} onClose={() => setComposing(false)}>
          <AnnouncementForm
            onCancel={() => setComposing(false)}
            onPosted={() => {
              setComposing(false);
              setNotice({ tone: 'success', text: t('engagement.feed.posted') });
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export default function EngagementHubPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<HubTab>('overview');

  if (!can(PERMISSIONS.ENGAGEMENT_MANAGE)) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h1 className="page-title">{t('engagement.title')}</h1>
        <p className="mt-1 text-sm text-ink-500">{t('engagement.subtitle')}</p>
      </div>
      <Tabs
        label={t('engagement.tabsLabel')}
        idPrefix="hub"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: t('engagement.tab.overview'), testId: 'hub-tab-overview' },
          { value: 'surveys', label: t('engagement.tab.surveys'), testId: 'hub-tab-surveys' },
          { value: 'categories', label: t('engagement.tab.categories'), testId: 'hub-tab-categories' },
          { value: 'feed', label: t('engagement.tab.feed'), testId: 'hub-tab-feed' },
        ]}
      />
      <div {...tabPanelProps('hub', tab)}>
        {tab === 'overview' && <EngagementOverviewPanel />}
        {tab === 'surveys' && <SurveyAdminList />}
        {tab === 'categories' && <CategoryAdmin />}
        {tab === 'feed' && <FeedTools />}
      </div>
    </div>
  );
}
