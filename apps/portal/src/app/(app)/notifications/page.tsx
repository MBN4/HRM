'use client';

import { useI18n } from '../../../i18n/I18nProvider';
import { useAsync } from '../../../lib/useAsync';
import { listNotifications, markNotificationRead } from '../../../lib/api/notifications';
import { formatDateTime } from '../../../lib/format';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

export default function NotificationsPage() {
  const { t, locale } = useI18n();
  const { data: notifications, loading, reload } = useAsync(() => listNotifications(), []);

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('notifications.title')}</h1>
      <Card>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !notifications || notifications.length === 0 ? (
            <EmptyState title={t('notifications.empty')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {notifications.map((n) => (
                <li key={n.id} className="flex items-start justify-between gap-4 py-3">
                  <div>
                    <p className={`text-sm ${n.delivery.readAt ? 'text-ink-500' : 'font-medium text-ink-900'}`}>
                      {n.delivery.renderedSubject ?? n.eventType}
                    </p>
                    {n.delivery.renderedBody && <p className="mt-0.5 text-xs text-ink-400">{n.delivery.renderedBody}</p>}
                    <p className="mt-1 text-xs text-ink-300">{formatDateTime(n.createdAt, locale)}</p>
                  </div>
                  {!n.delivery.readAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await markNotificationRead(n.delivery.id);
                        reload();
                      }}
                    >
                      {t('notifications.markRead')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
