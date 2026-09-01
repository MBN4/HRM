'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import {
  closeJobPosting,
  closeJobRequisition,
  listJobPostings,
  listJobRequisitions,
  publishJobPosting,
  submitJobRequisitionForApproval,
} from '../../../lib/api/recruitment';
import { listBranches } from '../../../lib/api/tenancy';
import { ApiError } from '../../../lib/api/client';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { CreateRequisitionForm } from '../../../components/recruitment/CreateRequisitionForm';
import { CreatePostingForm } from '../../../components/recruitment/CreatePostingForm';
import { WorkflowStatusPanel } from '../../../components/workflow/WorkflowStatusPanel';

type Tab = 'requisitions' | 'postings';

/**
 * Two tabs (simple client-side toggle, not separate routes) — "functional
 * over fancy" per the plan. Row actions Submit/Close (requisitions) and
 * Publish/Close (postings) are gated on `recruitment.manage`; creating a
 * requisition only needs `recruitment.write`. No department/designation
 * pickers anywhere on this page (documented limitation — see
 * docs/conventions/recruitment-lifecycle.md).
 */
export default function RecruitmentPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('requisitions');
  const [creatingRequisition, setCreatingRequisition] = useState(false);
  const [creatingPosting, setCreatingPosting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedRequisitionId, setExpandedRequisitionId] = useState<string | null>(null);

  const canView = can(PERMISSIONS.RECRUITMENT_READ) || can(PERMISSIONS.RECRUITMENT_MANAGE);
  const canWrite = can(PERMISSIONS.RECRUITMENT_WRITE);
  const canManage = can(PERMISSIONS.RECRUITMENT_MANAGE);

  const { data: branches } = useAsync(() => (canView ? listBranches() : Promise.resolve([])), [canView]);
  const { data: requisitions, loading: loadingRequisitions, reload: reloadRequisitions } = useAsync(
    () => (canView ? listJobRequisitions() : Promise.resolve([])),
    [canView],
  );
  const { data: postings, loading: loadingPostings, reload: reloadPostings } = useAsync(
    () => (canView ? listJobPostings() : Promise.resolve([])),
    [canView],
  );

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function branchName(branchId: string): string {
    return branches?.find((b) => b.id === branchId)?.name ?? `${branchId.slice(0, 8)}…`;
  }

  async function runAction(id: string, action: () => Promise<unknown>, reload: () => void) {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('nav.recruitment')}</h1>
        <div className="flex items-center gap-2">
          <Button
            data-testid="refresh-button"
            variant="secondary"
            size="sm"
            onClick={() => {
              reloadRequisitions();
              reloadPostings();
            }}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
          <Button data-testid="candidates-link" variant="secondary" onClick={() => router.push('/recruitment/candidates')}>
            {t('recruitment.candidates')}
          </Button>
          <Button data-testid="offers-link" variant="secondary" onClick={() => router.push('/recruitment/offers')}>
            {t('recruitment.offers')}
          </Button>
          {tab === 'requisitions' && canWrite && (
            <Button data-testid="new-requisition-button" onClick={() => setCreatingRequisition(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('recruitment.newRequisition')}
            </Button>
          )}
          {tab === 'postings' && canManage && (
            <Button data-testid="new-posting-button" onClick={() => setCreatingPosting(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('recruitment.newPosting')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-2 border-b border-ink-100">
        <button
          type="button"
          data-testid="requisitions-tab"
          onClick={() => setTab('requisitions')}
          className={`px-3 py-2 text-sm font-medium ${tab === 'requisitions' ? 'border-b-2 border-brand-600 text-brand-700' : 'text-ink-500 hover:text-ink-800'}`}
        >
          {t('recruitment.requisitions')}
        </button>
        <button
          type="button"
          data-testid="postings-tab"
          onClick={() => setTab('postings')}
          className={`px-3 py-2 text-sm font-medium ${tab === 'postings' ? 'border-b-2 border-brand-600 text-brand-700' : 'text-ink-500 hover:text-ink-800'}`}
        >
          {t('recruitment.postings')}
        </button>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}

      {tab === 'requisitions' && (
        <Card>
          <CardBody>
            {loadingRequisitions ? (
              <PageSpinner />
            ) : !requisitions || requisitions.length === 0 ? (
              <EmptyState title={t('recruitment.noRequisitions')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-2 text-start font-medium">{t('recruitment.title')}</th>
                      <th className="py-2 text-start font-medium">{t('common.branch')}</th>
                      <th className="py-2 text-start font-medium">{t('recruitment.employmentType')}</th>
                      <th className="py-2 text-start font-medium">{t('recruitment.headcount')}</th>
                      <th className="py-2 text-start font-medium">{t('common.status')}</th>
                      {canManage && <th className="py-2 text-start font-medium">{t('common.actions')}</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {requisitions.map((req) => (
                      <Fragment key={req.id}>
                        <tr data-testid="requisition-row" data-status={req.status}>
                          <td className="py-2.5 text-ink-800">
                            <button
                              type="button"
                              className="text-start hover:underline"
                              onClick={() => setExpandedRequisitionId(expandedRequisitionId === req.id ? null : req.id)}
                            >
                              {req.title}
                            </button>
                          </td>
                          <td className="py-2.5 text-ink-600">{branchName(req.branchId)}</td>
                          <td className="py-2.5 text-ink-600">{t(`analytics.employmentType.${req.employmentType}`)}</td>
                          <td className="py-2.5 text-ink-600">{req.headcount}</td>
                          <td className="py-2.5">
                            <StatusBadge status={req.status} label={t(`recruitment.requisitionStatus.${req.status}`)} />
                          </td>
                          {canManage && (
                            <td className="py-2.5">
                              <div className="flex gap-2">
                                {req.status === 'DRAFT' && (
                                  <Button
                                    data-testid="submit-requisition-button"
                                    size="sm"
                                    variant="secondary"
                                    loading={busyId === req.id}
                                    onClick={() => runAction(req.id, () => submitJobRequisitionForApproval(req.id), reloadRequisitions)}
                                  >
                                    {t('recruitment.submitForApproval')}
                                  </Button>
                                )}
                                {['APPROVED', 'REJECTED'].includes(req.status) && (
                                  <Button
                                    data-testid="close-requisition-button"
                                    size="sm"
                                    variant="secondary"
                                    loading={busyId === req.id}
                                    onClick={() => runAction(req.id, () => closeJobRequisition(req.id), reloadRequisitions)}
                                  >
                                    {t('recruitment.close')}
                                  </Button>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                        {expandedRequisitionId === req.id && req.workflowInstanceId && (
                          <tr>
                            <td colSpan={canManage ? 6 : 5} className="bg-sand-50 px-3 py-3">
                              <WorkflowStatusPanel workflowInstanceId={req.workflowInstanceId} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {tab === 'postings' && (
        <Card>
          <CardBody>
            {loadingPostings ? (
              <PageSpinner />
            ) : !postings || postings.length === 0 ? (
              <EmptyState title={t('common.noData')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-2 text-start font-medium">{t('recruitment.title')}</th>
                      <th className="py-2 text-start font-medium">{t('recruitment.publicSlug')}</th>
                      <th className="py-2 text-start font-medium">{t('common.status')}</th>
                      {canManage && <th className="py-2 text-start font-medium">{t('common.actions')}</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {postings.map((posting) => (
                      <tr key={posting.id} data-testid="posting-row" data-status={posting.status}>
                        <td className="py-2.5 text-ink-800">{posting.title}</td>
                        <td className="py-2.5 text-ink-600">{posting.publicSlug}</td>
                        <td className="py-2.5">
                          <StatusBadge status={posting.status} label={t(`recruitment.postingStatus.${posting.status}`)} />
                        </td>
                        {canManage && (
                          <td className="py-2.5">
                            <div className="flex gap-2">
                              {posting.status === 'DRAFT' && (
                                <Button
                                  data-testid="publish-posting-button"
                                  size="sm"
                                  variant="secondary"
                                  loading={busyId === posting.id}
                                  onClick={() => runAction(posting.id, () => publishJobPosting(posting.id), reloadPostings)}
                                >
                                  {t('recruitment.publish')}
                                </Button>
                              )}
                              {posting.status === 'PUBLISHED' && (
                                <Button
                                  data-testid="close-posting-button"
                                  size="sm"
                                  variant="secondary"
                                  loading={busyId === posting.id}
                                  onClick={() => runAction(posting.id, () => closeJobPosting(posting.id), reloadPostings)}
                                >
                                  {t('recruitment.close')}
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {creatingRequisition && (
        <Modal title={t('recruitment.newRequisition')} onClose={() => setCreatingRequisition(false)}>
          <CreateRequisitionForm
            onCancel={() => setCreatingRequisition(false)}
            onCreated={() => {
              setCreatingRequisition(false);
              reloadRequisitions();
            }}
          />
        </Modal>
      )}

      {creatingPosting && (
        <Modal title={t('recruitment.newPosting')} onClose={() => setCreatingPosting(false)}>
          <CreatePostingForm
            onCancel={() => setCreatingPosting(false)}
            onCreated={() => {
              setCreatingPosting(false);
              reloadPostings();
              router.push('/recruitment');
            }}
          />
        </Modal>
      )}
    </div>
  );
}
