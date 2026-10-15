'use client';

import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Newspaper } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { ApiError } from '../../../lib/api/client';
import { getFeed } from '../../../lib/api/engagement';
import type { FeedPost, FeedScope } from '../../../lib/api/types';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { Tabs, tabPanelProps } from '../../../components/ui/Tabs';
import { PageSpinner } from '../../../components/ui/Spinner';
import { AnnouncementForm } from '../../../components/engagement/AnnouncementForm';
import { FeedPostCard } from '../../../components/engagement/FeedPostCard';
import { RecognitionProfileModal } from '../../../components/engagement/RecognitionProfileModal';

export default function FeedPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canInteract = can(PERMISSIONS.RECOGNITION_GIVE);
  const canManage = can(PERMISSIONS.ENGAGEMENT_MANAGE);
  const [scope, setScope] = useState<FeedScope>('ALL');
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await getFeed({ scope, limit: 20 });
      setPosts(page.posts);
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const page = await getFeed({ scope, before: nextBefore, limit: 20 });
      setPosts((prev) => [...prev, ...page.posts.filter((p) => !prev.some((x) => x.id === p.id))]);
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">{t('feed.title')}</h1>
        {canManage && (
          <Button onClick={() => setComposing(true)} data-testid="new-announcement-post-button">
            <Megaphone className="h-4 w-4" aria-hidden />
            {t('feed.compose.open')}
          </Button>
        )}
      </div>

      <Tabs
        label={t('feed.scopeLabel')}
        idPrefix="feed"
        value={scope}
        onChange={setScope}
        tabs={[
          { value: 'ALL', label: t('feed.scope.ALL'), testId: 'feed-scope-ALL' },
          { value: 'ORG', label: t('feed.scope.ORG'), testId: 'feed-scope-ORG' },
          { value: 'TEAM', label: t('feed.scope.TEAM'), testId: 'feed-scope-TEAM' },
        ]}
      />

      <div className="space-y-4" {...tabPanelProps('feed', scope)} aria-live="polite">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <Alert tone="error">{error}</Alert>
        ) : posts.length === 0 ? (
          <EmptyState icon={Newspaper} title={t('feed.empty')} />
        ) : (
          <>
            {posts.map((p) => (
              <FeedPostCard key={p.id} post={p} canInteract={canInteract} canModerate={canManage} onOpenPerson={setProfileId} onRemoved={(id) => setPosts((prev) => prev.filter((x) => x.id !== id))} />
            ))}
            {nextBefore && (
              <div className="flex justify-center">
                <Button variant="secondary" onClick={loadMore} loading={loadingMore} data-testid="feed-load-more">
                  {t('feed.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {composing && (
        <Modal title={t('feed.compose.open')} onClose={() => setComposing(false)}>
          <AnnouncementForm
            onCancel={() => setComposing(false)}
            onPosted={() => {
              setComposing(false);
              load();
            }}
          />
        </Modal>
      )}
      {profileId && <RecognitionProfileModal employeeId={profileId} onClose={() => setProfileId(null)} />}
    </div>
  );
}
