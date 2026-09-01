'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { formatDate } from '../../lib/format';
import type { PendingApproval } from '../../lib/api/pending-approvals';
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
  if (approval.detail.instance.entityType === 'AttendanceRegularization') {
    return (
      <p className="text-sm text-ink-600">
        {t('attendance.workDate')}: {formatDate(snapshot.workDate as string, locale)}
      </p>
    );
  }
  return null;
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

        <SnapshotSummary approval={approval} locale={locale} />

        <WorkflowActionForm instanceId={approval.detail.instance.id} stepId={approval.step.id} onActed={onActed} />
      </CardBody>
    </Card>
  );
}
