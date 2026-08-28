'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { actOnWorkflowStep } from '../../lib/api/workflow';
import { ApiError } from '../../lib/api/client';
import { formatDate } from '../../lib/format';
import type { PendingApproval } from '../../lib/api/pending-approvals';
import { Card, CardBody } from '../ui/Card';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

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
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(actionType: 'APPROVE' | 'REJECT') {
    setBusy(actionType);
    setError(null);
    try {
      await actOnWorkflowStep(approval.detail.instance.id, approval.step.id, { actionType, comment: comment || undefined });
      onActed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setBusy(null);
    }
  }

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

        <Textarea
          placeholder={t('approvals.commentPlaceholder')}
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />

        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex justify-end gap-2">
          <Button
            data-testid="reject-button"
            variant="danger"
            size="sm"
            loading={busy === 'REJECT'}
            disabled={busy !== null}
            onClick={() => act('REJECT')}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            {t('approvals.reject')}
          </Button>
          <Button data-testid="approve-button" size="sm" loading={busy === 'APPROVE'} disabled={busy !== null} onClick={() => act('APPROVE')}>
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t('approvals.approve')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
