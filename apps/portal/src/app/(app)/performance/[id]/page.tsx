'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { formatDate } from '../../../../lib/format';
import { closeAppraisalCycle, getAppraisalCycle, getCalibration, listAppraisals, openAppraisalCycle, recomputeCalibration } from '../../../../lib/api/performance';
import { listBranches } from '../../../../lib/api/tenancy';
import { ApiError } from '../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { StatusBadge } from '../../../../components/ui/Badge';
import { Label, Select } from '../../../../components/ui/Field';
import { PageSpinner } from '../../../../components/ui/Spinner';

export default function AppraisalCycleDetailPage({ params }: { params: { id: string } }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState('');

  const canRead = can(PERMISSIONS.PERFORMANCE_READ);
  const canManage = can(PERMISSIONS.PERFORMANCE_MANAGE);

  const { data: branches } = useAsync(() => (canManage ? listBranches() : Promise.resolve([])), [canManage]);
  const { data: cycle, loading, error, reload } = useAsync(() => (canRead ? getAppraisalCycle(params.id) : Promise.resolve(null)), [canRead, params.id]);
  const { data: appraisals, reload: reloadAppraisals } = useAsync(
    () => (canRead ? listAppraisals({ cycleId: params.id }) : Promise.resolve([])),
    [canRead, params.id],
  );
  const {
    data: calibration,
    reload: reloadCalibration,
  } = useAsync(() => (canManage ? getCalibration(params.id, { branchId: branchFilter || undefined }) : Promise.resolve([])), [canManage, params.id, branchFilter]);

  if (!canRead) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  if (loading) return <PageSpinner />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!cycle) return <Alert tone="info">{t('error.notFound')}</Alert>;

  function refreshAll() {
    reload();
    reloadAppraisals();
    reloadCalibration();
  }

  async function handleOpen() {
    setBusyAction('open');
    setActionError(null);
    try {
      await openAppraisalCycle(params.id);
      refreshAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleClose() {
    setBusyAction('close');
    setActionError(null);
    try {
      await closeAppraisalCycle(params.id);
      refreshAll();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRecompute() {
    setBusyAction('recompute');
    setActionError(null);
    setActionNote(null);
    try {
      await recomputeCalibration(params.id);
      setActionNote(t('performance.recomputeQueued'));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyAction(null);
    }
  }

  const canOpen = canManage && cycle.status === 'DRAFT';
  const canClose = canManage && cycle.status === 'OPEN';

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('performance.title')}</h1>
        <Button data-testid="refresh-button" variant="secondary" size="sm" onClick={refreshAll}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('performance.refresh')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{cycle.name}</CardTitle>
          <span data-testid="cycle-status-badge">
            <StatusBadge status={cycle.status} label={t(`performance.cycleStatus.${cycle.status}`)} />
          </span>
        </CardHeader>
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('performance.cycleType')}</dt>
              <dd className="mt-0.5 text-sm text-ink-800">{t(`performance.cycleType.${cycle.cycleType}`)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('performance.startDate')}</dt>
              <dd className="mt-0.5 text-sm text-ink-800">{formatDate(cycle.startDate, locale)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('performance.endDate')}</dt>
              <dd className="mt-0.5 text-sm text-ink-800">{formatDate(cycle.endDate, locale)}</dd>
            </div>
          </dl>

          {actionError && <Alert tone="error">{actionError}</Alert>}
          {actionNote && <Alert tone="info">{actionNote}</Alert>}

          {(canOpen || canClose) && (
            <div className="flex gap-2 border-t border-ink-100 pt-4">
              {canOpen && (
                <Button data-testid="open-cycle-button" loading={busyAction === 'open'} onClick={handleOpen}>
                  {t('performance.open')}
                </Button>
              )}
              {canClose && (
                <Button data-testid="close-cycle-button" loading={busyAction === 'close'} onClick={handleClose}>
                  {t('performance.close')}
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('performance.appraisals')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!appraisals || appraisals.length === 0 ? (
            <p className="text-sm text-ink-400">{t('performance.noAppraisals')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('common.employee')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                    <th className="py-2 text-start font-medium">{t('performance.overallRating')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {appraisals.map((appraisal) => (
                    <tr
                      key={appraisal.id}
                      data-testid="appraisal-row"
                      data-status={appraisal.status}
                      data-employee-id={appraisal.employeeId}
                      tabIndex={0}
                      role="link"
                      aria-label={appraisal.employeeId}
                      className="cursor-pointer hover:bg-sand-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500"
                      onClick={() => router.push(`/performance/appraisals/${appraisal.id}`)}
                      onKeyDown={(e) => {
                        // role="link" activates on Enter only (Space is
                        // left to its native page-scroll behavior).
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          router.push(`/performance/appraisals/${appraisal.id}`);
                        }
                      }}
                    >
                      <td className="py-2.5 text-ink-800">{appraisal.employeeId}</td>
                      <td className="py-2.5">
                        <StatusBadge status={appraisal.status} label={t(`performance.appraisalStatus.${appraisal.status}`)} />
                      </td>
                      <td className="py-2.5 text-ink-600">{appraisal.overallRating ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>{t('performance.calibration')}</CardTitle>
            <Button data-testid="recompute-calibration-button" variant="secondary" size="sm" loading={busyAction === 'recompute'} onClick={handleRecompute}>
              {t('performance.recompute')}
            </Button>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="w-56">
              <Label htmlFor="calibration-branch">{t('common.branch')}</Label>
              <Select id="calibration-branch" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
                <option value="">{t('analytics.filters.allBranches')}</option>
                {(branches ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>

            {!calibration || calibration.length === 0 ? (
              <p className="text-sm text-ink-400">{t('common.noData')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-2 text-start font-medium">{t('common.branch')}</th>
                      <th className="py-2 text-start font-medium">{t('performance.department')}</th>
                      <th className="py-2 text-start font-medium">{t('performance.ratingValue')}</th>
                      <th className="py-2 text-start font-medium">{t('performance.employeeCount')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {calibration.map((row, index) => (
                      <tr key={index} data-testid="calibration-row">
                        <td className="py-2.5 text-ink-800">{branches?.find((b) => b.id === row.branchId)?.name ?? row.branchId}</td>
                        <td className="py-2.5 text-ink-600">{row.departmentId ?? '—'}</td>
                        <td className="py-2.5 text-ink-600" data-testid="calibration-rating-value">
                          {row.ratingValue}
                        </td>
                        <td className="py-2.5 text-ink-600" data-testid="calibration-employee-count">
                          {row.employeeCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
