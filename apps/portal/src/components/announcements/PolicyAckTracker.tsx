'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { listPolicyAcknowledgments } from '../../lib/api/announcements';
import { listEmployees } from '../../lib/api/employees';
import { StatusBadge } from '../ui/Badge';
import type { Policy } from '../../lib/api/types';

/**
 * Cross-references `PolicyAcknowledgment.userId` against `GET /employees`
 * client-side — the same "no dedicated picker/join endpoint" posture
 * frontend-admin-console.md already documents for interviewer/manager
 * pickers (see docs/conventions/operations-modules.md).
 */
export function PolicyAckTracker({ policy }: { policy: Policy }) {
  const { t } = useI18n();
  const { data: acks } = useAsync(() => listPolicyAcknowledgments(policy.id), [policy.id]);
  const { data: employees } = useAsync(() => listEmployees({ pageSize: 100 }), []);

  const ackedUserIds = new Set((acks ?? []).map((a) => a.userId));

  return (
    <details className="group" data-testid="policy-ack-row">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-1 py-2.5 text-sm hover:bg-sand-50">
        <span className="text-ink-800">
          {policy.title} <span className="text-ink-400">v{policy.version}</span>
        </span>
        <span className="text-ink-500">
          {t('policies.admin.acknowledgedCount', { count: acks?.length ?? 0 })}
        </span>
      </summary>
      <div className="border-t border-ink-100 px-1 py-3">
        <ul className="divide-y divide-ink-100 text-sm">
          {(employees?.data ?? [])
            .filter((e) => e.userId)
            .map((e) => (
              <li key={e.id} className="flex items-center justify-between py-1.5">
                <span className="text-ink-700">
                  {e.firstName} {e.lastName}
                </span>
                {ackedUserIds.has(e.userId!) ? (
                  <StatusBadge status="APPROVED" label={t('policies.acknowledged')} />
                ) : (
                  <StatusBadge status="PENDING" label={t('common.no')} />
                )}
              </li>
            ))}
        </ul>
      </div>
    </details>
  );
}
