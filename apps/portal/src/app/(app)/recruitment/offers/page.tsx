'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { acceptOffer, declineOffer, listOffers, submitOfferForApproval } from '../../../../lib/api/recruitment';
import { listBranches } from '../../../../lib/api/tenancy';
import { formatCurrency } from '../../../../lib/format';
import { ApiError } from '../../../../lib/api/client';
import { Card, CardBody } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { StatusBadge } from '../../../../components/ui/Badge';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { CreateOfferForm } from '../../../../components/recruitment/CreateOfferForm';
import { WorkflowStatusPanel } from '../../../../components/workflow/WorkflowStatusPanel';

export default function OffersPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acceptedNotice, setAcceptedNotice] = useState(false);
  const [expandedOfferId, setExpandedOfferId] = useState<string | null>(null);

  const canView = can(PERMISSIONS.RECRUITMENT_READ) || can(PERMISSIONS.RECRUITMENT_MANAGE);
  const canWrite = can(PERMISSIONS.RECRUITMENT_WRITE);
  const canManage = can(PERMISSIONS.RECRUITMENT_MANAGE);

  const { data: branches } = useAsync(() => (canView ? listBranches() : Promise.resolve([])), [canView]);
  const { data: offers, loading, reload } = useAsync(() => (canView ? listOffers() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function branchName(branchId: string): string {
    return branches?.find((b) => b.id === branchId)?.name ?? `${branchId.slice(0, 8)}…`;
  }

  async function runAction(id: string, action: () => Promise<unknown>) {
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

  async function handleAccept(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await acceptOffer(id);
      setAcceptedNotice(true);
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
        <h1 className="text-xl font-semibold text-ink-900">{t('recruitment.offers')}</h1>
        <div className="flex items-center gap-2">
          <Button data-testid="refresh-button" variant="secondary" size="sm" onClick={() => reload()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
          {canWrite && (
            <Button data-testid="new-offer-button" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('recruitment.newOffer')}
            </Button>
          )}
        </div>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}
      {acceptedNotice && (
        <Alert tone="info">
          {t('recruitment.onboardingStarted')} <Link href="/recruitment/onboarding" className="font-medium underline">{t('nav.onboarding')}</Link>
        </Alert>
      )}

      <Card>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !offers || offers.length === 0 ? (
            <EmptyState title={t('recruitment.noOffers')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('common.branch')}</th>
                    <th className="py-2 text-start font-medium">{t('recruitment.employmentType')}</th>
                    <th className="py-2 text-start font-medium">{t('recruitment.proposedSalary')}</th>
                    <th className="py-2 text-start font-medium">{t('recruitment.proposedJoinDate')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                    {canManage && <th className="py-2 text-start font-medium">{t('common.actions')}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {offers.map((offer) => (
                    <Fragment key={offer.id}>
                      <tr data-testid="offer-row" data-status={offer.status}>
                        <td className="py-2.5 text-ink-800">
                          <button type="button" className="hover:underline" onClick={() => setExpandedOfferId(expandedOfferId === offer.id ? null : offer.id)}>
                            {branchName(offer.branchId)}
                          </button>
                        </td>
                        <td className="py-2.5 text-ink-600">{t(`analytics.employmentType.${offer.employmentType}`)}</td>
                        <td className="py-2.5 text-ink-600">{formatCurrency(offer.proposedSalary, offer.salaryCurrency, locale)}</td>
                        <td className="py-2.5 text-ink-600">{offer.proposedJoinDate}</td>
                        <td className="py-2.5">
                          <StatusBadge status={offer.status} label={t(`recruitment.offerStatus.${offer.status}`)} />
                        </td>
                        {canManage && (
                          <td className="py-2.5">
                            <div className="flex gap-2">
                              {offer.status === 'DRAFT' && (
                                <Button
                                  data-testid="submit-offer-button"
                                  size="sm"
                                  variant="secondary"
                                  loading={busyId === offer.id}
                                  onClick={() => runAction(offer.id, () => submitOfferForApproval(offer.id))}
                                >
                                  {t('recruitment.submitForApproval')}
                                </Button>
                              )}
                              {offer.status === 'APPROVED' && (
                                <>
                                  <Button
                                    data-testid="accept-offer-button"
                                    size="sm"
                                    loading={busyId === offer.id}
                                    onClick={() => handleAccept(offer.id)}
                                  >
                                    {t('recruitment.accept')}
                                  </Button>
                                  <Button
                                    data-testid="decline-offer-button"
                                    size="sm"
                                    variant="secondary"
                                    loading={busyId === offer.id}
                                    onClick={() => runAction(offer.id, () => declineOffer(offer.id))}
                                  >
                                    {t('recruitment.decline')}
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                      {expandedOfferId === offer.id && offer.workflowInstanceId && (
                        <tr>
                          <td colSpan={canManage ? 6 : 5} className="bg-sand-50 px-3 py-3">
                            <WorkflowStatusPanel workflowInstanceId={offer.workflowInstanceId} />
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

      {creating && (
        <Modal title={t('recruitment.newOffer')} onClose={() => setCreating(false)}>
          <CreateOfferForm
            onCancel={() => setCreating(false)}
            onCreated={() => {
              setCreating(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
