'use client';

import { useI18n } from '../../../i18n/I18nProvider';
import { useAsync } from '../../../lib/useAsync';
import { loadPendingApprovals } from '../../../lib/api/pending-approvals';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { ApprovalCard } from '../../../components/approvals/ApprovalCard';
import { ClipboardCheck } from 'lucide-react';

export default function ApprovalsPage() {
  const { t, locale } = useI18n();
  const { data: approvals, loading, reload } = useAsync(() => loadPendingApprovals(), []);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('approvals.title')}</h1>

      {loading ? (
        <PageSpinner />
      ) : !approvals || approvals.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t('approvals.empty')} />
      ) : (
        <div className="space-y-4">
          {approvals.map((approval) => (
            <ApprovalCard key={approval.step.id} approval={approval} locale={locale} onActed={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
