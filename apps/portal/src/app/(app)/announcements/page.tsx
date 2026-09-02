'use client';

import { useState } from 'react';
import { Megaphone } from 'lucide-react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAsync } from '../../../lib/useAsync';
import { acknowledgePolicy, listActivePolicies, listMyAnnouncements, myPolicyAcknowledgments } from '../../../lib/api/announcements';
import { ApiError } from '../../../lib/api/client';
import { formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

/**
 * Wires the ESS "announcements seam" left as a placeholder in step 1.4 to
 * real, tenant-authored data — see docs/conventions/operations-modules.md.
 * Policies live on the same page (both are "read, and possibly
 * acknowledge" ESS actions) rather than a second route.
 */
export default function AnnouncementsPage() {
  const { t, locale } = useI18n();
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: announcements, loading: announcementsLoading } = useAsync(() => listMyAnnouncements(), []);
  const { data: policies, loading: policiesLoading } = useAsync(() => listActivePolicies(), []);
  const { data: myAcks, reload: reloadAcks } = useAsync(() => myPolicyAcknowledgments(), []);

  const ackedPolicyIds = new Set((myAcks ?? []).map((a) => a.policyId));

  async function handleAcknowledge(policyId: string) {
    setAckingId(policyId);
    setError(null);
    try {
      await acknowledgePolicy(policyId);
      reloadAcks();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setAckingId(null);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('announcements.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('announcements.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          {announcementsLoading ? (
            <PageSpinner />
          ) : !announcements || announcements.length === 0 ? (
            <EmptyState icon={Megaphone} title={t('announcements.noAnnouncements')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {announcements.map((a) => (
                <li key={a.id} data-testid="announcement-row" className="py-3">
                  <p className="text-sm font-semibold text-ink-900">{a.title}</p>
                  <p className="mt-1 text-sm text-ink-600">{a.body}</p>
                  <p className="mt-1 text-xs text-ink-400">{formatDate(a.publishedAt, locale)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policies.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          {error && (
            <div className="mb-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
          {policiesLoading ? (
            <PageSpinner />
          ) : !policies || policies.length === 0 ? (
            <EmptyState title={t('policies.noPolicies')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {policies.map((p) => (
                <li key={p.id} data-testid="policy-row" className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">
                      {p.title} <span className="text-ink-400">v{p.version}</span>
                    </p>
                    <p className="mt-1 text-sm text-ink-600 line-clamp-2">{p.body}</p>
                  </div>
                  {p.requiresAcknowledgment &&
                    (ackedPolicyIds.has(p.id) ? (
                      <span className="shrink-0 text-xs font-medium text-brand-700">{t('policies.acknowledged')}</span>
                    ) : (
                      <Button
                        size="sm"
                        loading={ackingId === p.id}
                        onClick={() => handleAcknowledge(p.id)}
                        data-testid="acknowledge-policy-button"
                      >
                        {t('policies.acknowledge')}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
