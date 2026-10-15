'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { getRecognitionProfile } from '../../lib/api/engagement';
import { Alert } from '../ui/Alert';
import { EmptyState } from '../ui/EmptyState';
import { Modal } from '../ui/Modal';
import { PageSpinner } from '../ui/Spinner';
import { RecognitionCard } from './RecognitionCard';

/** A person's recognition profile (totals, by value, recent). Another person's view is public-only — the server decides. */
export function RecognitionProfileModal({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data, loading, error } = useAsync(() => getRecognitionProfile(employeeId), [employeeId]);
  return (
    <Modal title={data ? t('recognition.profile.title', { name: data.employee.name }) : t('recognition.profile.titleGeneric')} onClose={onClose}>
      {loading ? (
        <PageSpinner />
      ) : error || !data ? (
        <Alert tone="error">{error ?? t('error.generic')}</Alert>
      ) : (
        <div className="space-y-4" data-testid="recognition-profile">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-ink-100 p-3">
              <p className="text-xs text-ink-400">{data.isSelf ? t('recognition.profile.totalPoints') : t('recognition.profile.publicPoints')}</p>
              <p className="text-2xl font-semibold text-ink-900" data-testid="profile-points">{data.totalPoints}</p>
            </div>
            <div className="rounded-xl border border-ink-100 p-3">
              <p className="text-xs text-ink-400">{t('recognition.profile.received')}</p>
              <p className="text-2xl font-semibold text-ink-900">{data.receivedCount}</p>
            </div>
          </div>
          {!data.isSelf && <p className="text-xs text-ink-500">{t('recognition.profile.publicOnly')}</p>}
          {data.byCategory.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('recognition.profile.byCategory')}</h3>
              <ul className="space-y-1 text-sm">
                {data.byCategory.map((c) => (
                  <li key={c.categoryId} className="flex justify-between">
                    <span className="text-ink-800">{c.name}</span>
                    <span className="text-ink-500">{c.count} · {t('recognition.points', { count: c.points })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('recognition.profile.recent')}</h3>
            {data.recent.length === 0 ? (
              <EmptyState title={t('recognition.empty.received')} />
            ) : (
              <div className="divide-y divide-ink-100">
                {data.recent.map((r) => (
                  <div key={r.id} className="py-3">
                    <RecognitionCard recognition={r} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
