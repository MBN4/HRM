'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { deactivateAnnouncement, listAllAnnouncements, listAllPolicies } from '../../../../lib/api/announcements';
import { formatDate } from '../../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { StatusBadge } from '../../../../components/ui/Badge';
import { AnnouncementForm } from '../../../../components/announcements/AnnouncementForm';
import { PolicyForm } from '../../../../components/announcements/PolicyForm';
import { PolicyAckTracker } from '../../../../components/announcements/PolicyAckTracker';

export default function AnnouncementsAdminPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [creatingAnnouncement, setCreatingAnnouncement] = useState(false);
  const [creatingPolicy, setCreatingPolicy] = useState(false);

  const canManageAnnouncements = can(PERMISSIONS.ANNOUNCEMENT_MANAGE);
  const canManagePolicies = can(PERMISSIONS.POLICY_MANAGE);

  const { data: announcements, loading: announcementsLoading, reload: reloadAnnouncements } = useAsync(
    () => (canManageAnnouncements ? listAllAnnouncements() : Promise.resolve([])),
    [canManageAnnouncements],
  );
  const { data: policies, loading: policiesLoading, reload: reloadPolicies } = useAsync(
    () => (canManagePolicies ? listAllPolicies() : Promise.resolve([])),
    [canManagePolicies],
  );

  if (!canManageAnnouncements && !canManagePolicies) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  async function handleDeactivate(id: string) {
    await deactivateAnnouncement(id);
    reloadAnnouncements();
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('announcements.admin.title')}</h1>

      {canManageAnnouncements && (
        <Card>
          <CardHeader>
            <CardTitle>{t('announcements.title')}</CardTitle>
            <Button size="sm" data-testid="new-announcement-button" onClick={() => setCreatingAnnouncement(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('announcements.admin.newAnnouncement')}
            </Button>
          </CardHeader>
          <CardBody>
            {announcementsLoading ? (
              <PageSpinner />
            ) : !announcements || announcements.length === 0 ? (
              <EmptyState title={t('announcements.noAnnouncements')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {announcements.map((a) => (
                  <li key={a.id} data-testid="admin-announcement-row" className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-semibold text-ink-900">{a.title}</p>
                      <p className="text-xs text-ink-400">{formatDate(a.publishedAt, locale)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={a.isActive ? 'APPROVED' : 'CANCELED'} label={a.isActive ? t('common.yes') : t('common.no')} />
                      {a.isActive && (
                        <Button size="sm" variant="secondary" onClick={() => handleDeactivate(a.id)}>
                          {t('announcements.admin.deactivate')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {canManagePolicies && (
        <Card>
          <CardHeader>
            <CardTitle>{t('policies.title')}</CardTitle>
            <Button size="sm" data-testid="new-policy-button" onClick={() => setCreatingPolicy(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('policies.admin.newPolicy')}
            </Button>
          </CardHeader>
          <CardBody>
            {policiesLoading ? (
              <PageSpinner />
            ) : !policies || policies.length === 0 ? (
              <EmptyState title={t('policies.noPolicies')} />
            ) : (
              <div className="divide-y divide-ink-100">
                {policies.map((p) => (
                  <PolicyAckTracker key={p.id} policy={p} />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {creatingAnnouncement && (
        <Modal title={t('announcements.admin.newAnnouncement')} onClose={() => setCreatingAnnouncement(false)}>
          <AnnouncementForm
            onCancel={() => setCreatingAnnouncement(false)}
            onSubmitted={() => {
              setCreatingAnnouncement(false);
              reloadAnnouncements();
            }}
          />
        </Modal>
      )}

      {creatingPolicy && (
        <Modal title={t('policies.admin.newPolicy')} onClose={() => setCreatingPolicy(false)}>
          <PolicyForm
            onCancel={() => setCreatingPolicy(false)}
            onSubmitted={() => {
              setCreatingPolicy(false);
              reloadPolicies();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
