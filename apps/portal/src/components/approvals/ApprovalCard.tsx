'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { formatCurrency, formatDate } from '../../lib/format';
import type { PendingApproval } from '../../lib/api/pending-approvals';
import type { ViewerReason } from '../../lib/api/types';
import { Badge } from '../ui/Badge';
import { Card, CardBody } from '../ui/Card';
import { WorkflowActionForm } from '../workflow/WorkflowActionForm';

function SnapshotSummary({ approval, locale }: { approval: PendingApproval; locale: string }) {
  const { t } = useI18n();
  const snapshot = approval.detail.instance.dataSnapshot;
  if (approval.detail.instance.entityType === 'LeaveRequest') {
    return (
      <p className="text-sm text-ink-600">
        {t(`leave.type.${snapshot.leaveType}`)} · {formatDate(snapshot.startDate as string, locale)} – {formatDate(snapshot.endDate as string, locale)} ·{' '}
        {t('leave.days', { count: snapshot.days })}
      </p>
    );
  }
  if (approval.detail.instance.entityType === 'EXPENSE_CLAIM') {
    return (
      <p className="text-sm text-ink-600">{formatCurrency(Number(snapshot.amount), snapshot.currencyCode as string, locale)}</p>
    );
  }
  if (approval.detail.instance.entityType === 'AttendanceRegularization') {
    return (
      <p className="text-sm text-ink-600">
        {t('attendance.workDate')}: {formatDate(snapshot.workDate as string, locale)}
      </p>
    );
  }
  return null;
}

const REASON_TONE: Record<ViewerReason, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  DIRECT_MANAGER: 'success',
  ESCALATED_MANAGER_UNAVAILABLE: 'warning',
  CEO_TOP_OF_CHAIN: 'info',
  CEO_ESCALATED: 'warning',
  ADMIN_FALLBACK: 'neutral',
  DELEGATED: 'info',
  ESCALATED_OVERDUE: 'danger',
  ASSIGNED: 'neutral',
  CEO_OVERRIDE: 'info',
};

/** Step 7.2 — WHY this request is in my queue: a short badge + one plain sentence. */
function ReasonLine({ reason }: { reason: ViewerReason }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600" data-testid="approval-reason" data-reason={reason}>
      <Badge tone={REASON_TONE[reason]}>{t(`approvals.reason.${reason}`)}</Badge>
      <span>{t(`approvals.reason.${reason}.hint`)}</span>
    </div>
  );
}

export function ApprovalCard({ approval, locale, onActed }: { approval: PendingApproval; locale: string; onActed: () => void }) {
  const { t } = useI18n();

  const entityLabel = t(`approvals.entity.${approval.detail.instance.entityType}`);
  const employeeName = approval.employee ? `${approval.employee.firstName} ${approval.employee.lastName}` : approval.detail.instance.requesterId;

  return (
    <Card data-testid="approval-card" data-entity-type={approval.detail.instance.entityType}>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-ink-900">{entityLabel}</p>
            <p className="text-xs text-ink-400">
              {t('approvals.requestedBy')}: {employeeName}
            </p>
          </div>
          <span className="text-xs text-ink-400">{t('approvals.step', { name: approval.step.name })}</span>
        </div>

        {approval.step.viewerReason && <ReasonLine reason={approval.step.viewerReason} />}

        <SnapshotSummary approval={approval} locale={locale} />

        <WorkflowActionForm instanceId={approval.detail.instance.id} stepId={approval.step.id} onActed={onActed} />
      </CardBody>
    </Card>
  );
}
