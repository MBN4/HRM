'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { closeAppraisalCycle, listAppraisalCycles, openAppraisalCycle } from '../../../lib/api/performance';
import { formatDate } from '../../../lib/format';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { CreateCycleForm } from '../../../components/performance/CreateCycleForm';
import type { AppraisalCycle } from '../../../lib/api/types';

export default function PerformancePage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canRead = can(PERMISSIONS.PERFORMANCE_READ);
  const canManage = can(PERMISSIONS.PERFORMANCE_MANAGE);
  const canReview = can(PERMISSIONS.PERFORMANCE_REVIEW);

  const { data: cycles, loading, reload } = useAsync(() => (canRead ? listAppraisalCycles() : Promise.resolve([])), [canRead]);

  if (!canRead) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  async function handleOpen(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await openAppraisalCycle(id);
      reload();
    } catch {
      setActionError(t('error.generic'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleClose(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await closeAppraisalCycle(id);
      reload();
    } catch {
      setActionError(t('error.generic'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('performance.title')}</h1>
        <div className="flex items-center gap-2">
          {canReview && (
            <Button variant="secondary" data-testid="my-reviews-link" onClick={() => router.push('/performance/my-reviews')}>
              {t('performance.myReviews')}
            </Button>
          )}
          {canManage && (
            <Button data-testid="new-cycle-button" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('performance.newCycle')}
            </Button>
          )}
        </div>
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}

      <Card>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !cycles || cycles.length === 0 ? (
            <EmptyState title={t('performance.noCycles')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('performance.cycleName')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.cycleType')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.startDate')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.endDate')}</th>
                    {canManage && <th className="py-2 text-start font-medium">{t('common.actions')}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {cycles.map((cycle: AppraisalCycle) => (
                    <tr
                      key={cycle.id}
                      data-testid="cycle-row"
                      data-status={cycle.status}
                      className="cursor-pointer hover:bg-sand-50"
                      onClick={() => router.push(`/performance/${cycle.id}`)}
                    >
                      <td className="py-2.5 text-ink-800">{cycle.name}</td>
                      <td className="py-2.5 text-ink-600">{t(`performance.cycleType.${cycle.cycleType}`)}</td>
                      <td className="py-2.5">
                        <StatusBadge status={cycle.status} label={t(`performance.cycleStatus.${cycle.status}`)} />
                      </td>
                      <td className="py-2.5 text-ink-600">{formatDate(cycle.startDate, locale)}</td>
                      <td className="py-2.5 text-ink-600">{formatDate(cycle.endDate, locale)}</td>
                      {canManage && (
                        <td className="py-2.5">
                          <div className="flex gap-2">
                            {cycle.status === 'DRAFT' && (
                              <Button
                                data-testid="open-cycle-button"
                                size="sm"
                                variant="secondary"
                                loading={busyId === cycle.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpen(cycle.id);
                                }}
                              >
                                {t('performance.open')}
                              </Button>
                            )}
                            {cycle.status === 'OPEN' && (
                              <Button
                                data-testid="close-cycle-button"
                                size="sm"
                                variant="secondary"
                                loading={busyId === cycle.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleClose(cycle.id);
                                }}
                              >
                                {t('performance.close')}
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

      {creating && (
        <Modal title={t('performance.newCycle')} onClose={() => setCreating(false)}>
          <CreateCycleForm
            onCancel={() => setCreating(false)}
            onCreated={(cycle) => {
              setCreating(false);
              reload();
              router.push(`/performance/${cycle.id}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
