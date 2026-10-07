'use client';

import { useI18n } from '../../../i18n/I18nProvider';
import { useAsync } from '../../../lib/useAsync';
import { loadPendingApprovals } from '../../../lib/api/pending-approvals';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { ApprovalCard } from '../../../components/approvals/ApprovalCard';
import { ClipboardCheck } from 'lucide-react';
import type { PendingApproval } from '../../../lib/api/pending-approvals';
import type { ViewerReason } from '../../../lib/api/types';

// Items addressed to me come first, closest-to-me reasons earliest.
const REASON_ORDER: ViewerReason[] = ['DELEGATED', 'DIRECT_MANAGER', 'ESCALATED_MANAGER_UNAVAILABLE', 'CEO_TOP_OF_CHAIN', 'CEO_ESCALATED', 'ESCALATED_OVERDUE', 'ASSIGNED', 'ADMIN_FALLBACK', 'CEO_OVERRIDE'];
const rank = (a: PendingApproval) => {
  const i = REASON_ORDER.indexOf(a.step.viewerReason ?? 'ASSIGNED');
  return i === -1 ? REASON_ORDER.length : i;
};

export default function ApprovalsPage() {
  const { t, locale } = useI18n();
  const { data: approvals, loading, reload } = useAsync(() => loadPendingApprovals(), []);

  const sorted = [...(approvals ?? [])].sort((a, b) => rank(a) - rank(b));
  const mine = sorted.filter((a) => a.step.viewerReason !== 'CEO_OVERRIDE');
  const orgWide = sorted.filter((a) => a.step.viewerReason === 'CEO_OVERRIDE');

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="page-title">{t('approvals.title')}</h1>

      {loading ? (
        <PageSpinner />
      ) : !approvals || approvals.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t('approvals.empty')} />
      ) : (
        <>
          {mine.length > 0 && (
            <section className="space-y-4" aria-labelledby="approvals-mine" data-testid="approvals-section-mine">
              {orgWide.length > 0 && (
                <h2 id="approvals-mine" className="text-sm font-semibold text-ink-700">
                  {t('approvals.section.mine')}
                </h2>
              )}
              {mine.map((approval) => (
                <ApprovalCard key={approval.step.id} approval={approval} locale={locale} onActed={reload} />
              ))}
            </section>
          )}
          {orgWide.length > 0 && (
            <section className="space-y-4" aria-labelledby="approvals-org" data-testid="approvals-section-org">
              <div>
                <h2 id="approvals-org" className="text-sm font-semibold text-ink-700">
                  {t('approvals.section.org')}
                </h2>
                <p className="text-xs text-ink-500">{t('approvals.section.orgHint')}</p>
              </div>
              {orgWide.map((approval) => (
                <ApprovalCard key={approval.step.id} approval={approval} locale={locale} onActed={reload} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
