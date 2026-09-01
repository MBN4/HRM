'use client';

import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../../i18n/I18nProvider';
import { useAuth } from '../../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../../lib/useAsync';
import { formatDateTime } from '../../../../../lib/format';
import { getAppraisal, submitAppraisalForApproval } from '../../../../../lib/api/performance';
import { ApiError } from '../../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../../components/ui/Card';
import { Button } from '../../../../../components/ui/Button';
import { Alert } from '../../../../../components/ui/Alert';
import { StatusBadge } from '../../../../../components/ui/Badge';
import { Modal } from '../../../../../components/ui/Modal';
import { PageSpinner } from '../../../../../components/ui/Spinner';
import { AssignPeersForm } from '../../../../../components/performance/AssignPeersForm';
import { WorkflowStatusPanel } from '../../../../../components/workflow/WorkflowStatusPanel';

export default function AppraisalDetailPage({ params }: { params: { id: string } }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [assigning, setAssigning] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canRead = can(PERMISSIONS.PERFORMANCE_READ);
  const canManage = can(PERMISSIONS.PERFORMANCE_MANAGE);

  const { data: appraisal, loading, error, reload } = useAsync(() => (canRead ? getAppraisal(params.id) : Promise.resolve(null)), [canRead, params.id]);

  const allSubmitted = useMemo(() => {
    if (!appraisal) return false;
    return appraisal.assignments.length > 0 && appraisal.assignments.every((a) => a.status === 'SUBMITTED');
  }, [appraisal]);

  if (!canRead) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  if (loading) return <PageSpinner />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!appraisal) return <Alert tone="info">{t('error.notFound')}</Alert>;

  const canSubmitForApproval = canManage && ['DRAFT', 'IN_PROGRESS'].includes(appraisal.status) && allSubmitted;

  async function handleSubmitForApproval() {
    setBusyAction('submit');
    setActionError(null);
    try {
      await submitAppraisalForApproval(params.id);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">
          {appraisal.employee.firstName} {appraisal.employee.lastName} ({appraisal.employee.employeeCode})
        </h1>
        <Button data-testid="refresh-button" variant="secondary" size="sm" onClick={() => reload()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('performance.refresh')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('performance.appraisals')}</CardTitle>
          <span data-testid="appraisal-status-badge">
            <StatusBadge status={appraisal.status} label={t(`performance.appraisalStatus.${appraisal.status}`)} />
          </span>
        </CardHeader>
        <CardBody className="space-y-4">
          {actionError && <Alert tone="error">{actionError}</Alert>}

          <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-4">
            {canManage && (
              <Button data-testid="assign-peers-button" variant="secondary" onClick={() => setAssigning(true)}>
                {t('performance.assignPeers')}
              </Button>
            )}
            {canManage && canSubmitForApproval && (
              <Button data-testid="submit-for-approval-button" loading={busyAction === 'submit'} onClick={handleSubmitForApproval}>
                {t('performance.submitForApproval')}
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <WorkflowStatusPanel workflowInstanceId={appraisal.workflowInstanceId} />

      <Card>
        <CardHeader>
          <CardTitle>{t('performance.assignments')}</CardTitle>
        </CardHeader>
        <CardBody>
          {appraisal.assignments.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('performance.reviewType')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.reviewer')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {appraisal.assignments.map((assignment) => (
                    <tr key={assignment.id} data-testid="assignment-row" data-status={assignment.status}>
                      <td className="py-2.5 text-ink-800">{t(`performance.reviewType.${assignment.reviewType}`)}</td>
                      <td className="py-2.5 text-ink-600">{assignment.reviewerId}</td>
                      <td className="py-2.5">
                        <StatusBadge status={assignment.status} label={t(`performance.assignmentStatus.${assignment.status}`)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('performance.reviews')}</CardTitle>
        </CardHeader>
        <CardBody>
          {appraisal.reviews.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('performance.reviewType')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.overallRating')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.strengths')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.improvements')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.comments')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.submittedAt')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {appraisal.reviews.map((review) => (
                    <tr key={review.id} data-testid="review-row">
                      <td className="py-2.5 text-ink-800">{t(`performance.reviewType.${review.reviewType}`)}</td>
                      <td className="py-2.5 text-ink-600">{review.overallRating}</td>
                      <td className="py-2.5 text-ink-600">{review.strengths ?? '—'}</td>
                      <td className="py-2.5 text-ink-600">{review.improvements ?? '—'}</td>
                      <td className="py-2.5 text-ink-600">{review.comments ?? '—'}</td>
                      <td className="py-2.5 text-ink-600">{formatDateTime(review.submittedAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {assigning && (
        <Modal title={t('performance.assignPeers')} onClose={() => setAssigning(false)}>
          <AssignPeersForm
            appraisalId={params.id}
            onCancel={() => setAssigning(false)}
            onAssigned={() => {
              setAssigning(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
