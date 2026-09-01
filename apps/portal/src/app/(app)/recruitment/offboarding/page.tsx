'use client';

import { Fragment, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import {
  completeOffboardingProcess,
  completeOffboardingTask,
  getMyOffboardingTasks,
  getOffboardingProcess,
  listOffboardingProcesses,
} from '../../../../lib/api/offboarding';
import { Card, CardBody } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { StatusBadge } from '../../../../components/ui/Badge';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { InitiateOffboardingForm } from '../../../../components/offboarding/InitiateOffboardingForm';
import { MyTasksList } from '../../../../components/checklists/MyTasksList';
import { WorkflowStatusPanel } from '../../../../components/workflow/WorkflowStatusPanel';
import { ApiError } from '../../../../lib/api/client';
import type { OffboardingProcess } from '../../../../lib/api/types';

function ProcessDetailPanel({ process, canManage, onCompleted }: { process: OffboardingProcess; canManage: boolean; onCompleted: (run: string) => void }) {
  const { t } = useI18n();
  const { data: detail, loading, reload } = useAsync(() => getOffboardingProcess(process.id), [process.id]);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasks = detail?.tasks ?? [];
  const allCompleted = tasks.length > 0 && tasks.every((task) => task.status === 'COMPLETED');
  const canComplete = canManage && process.status === 'APPROVED';

  async function handleComplete() {
    setCompleting(true);
    setError(null);
    try {
      const updated = await completeOffboardingProcess(process.id);
      reload();
      if (updated.settlementPayrollRunId) {
        onCompleted(updated.settlementPayrollRunId);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setCompleting(false);
    }
  }

  return (
    <div className="space-y-4">
      {loading ? (
        <PageSpinner />
      ) : tasks.length === 0 ? (
        <p className="text-sm text-ink-400">{t('common.noData')}</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((task) => (
            <li key={task.id} data-testid="offboarding-process-task-row" className="flex items-center justify-between text-sm">
              <span className="text-ink-700">
                {task.title} <span className="text-ink-400">({task.category})</span>
              </span>
              <StatusBadge status={task.status} label={task.status} />
            </li>
          ))}
        </ul>
      )}

      <WorkflowStatusPanel workflowInstanceId={process.workflowInstanceId} />

      {canComplete && (
        <div className="space-y-2 border-t border-ink-100 pt-3">
          {!allCompleted && <Alert tone="info">{t('offboarding.notAllTasksCompleted')}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
          <Button data-testid="complete-offboarding-button" loading={completing} onClick={handleComplete}>
            {t('offboarding.complete')}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function OffboardingPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [initiating, setInitiating] = useState(false);
  const [settlementRunId, setSettlementRunId] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.OFFBOARDING_MANAGE);

  const { data: processes, loading, reload } = useAsync(() => (canManage ? listOffboardingProcesses() : Promise.resolve([])), [canManage]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('offboarding.processes')}</h1>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button data-testid="refresh-button" variant="secondary" size="sm" onClick={() => reload()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {canManage && (
            <Button data-testid="initiate-offboarding-button" onClick={() => setInitiating(true)}>
              {t('offboarding.initiate')}
            </Button>
          )}
        </div>
      </div>

      {settlementRunId && (
        <Alert tone="success">
          {t('offboarding.settlementRun')}:{' '}
          <a href={`/payroll/${settlementRunId}`} className="font-medium underline" data-testid="settlement-run-link">
            {t('payroll.title')}
          </a>
        </Alert>
      )}

      {canManage && (
        <Card>
          <CardBody>
            {loading ? (
              <PageSpinner />
            ) : !processes || processes.length === 0 ? (
              <EmptyState title={t('offboarding.noProcesses')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-2 text-start font-medium">{t('common.status')}</th>
                      <th className="py-2 text-start font-medium">{t('common.employee')}</th>
                      <th className="py-2 text-start font-medium">{t('common.reason')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {processes.map((process) => (
                      <Fragment key={process.id}>
                        <tr data-testid="offboarding-process-row" data-status={process.status} className="cursor-pointer hover:bg-sand-50" onClick={() => setExpandedId(expandedId === process.id ? null : process.id)}>
                          <td className="py-2.5">
                            <StatusBadge status={process.status} label={t(`offboarding.status.${process.status}`)} />
                          </td>
                          <td className="py-2.5 text-ink-600">{process.employeeId}</td>
                          <td className="py-2.5 text-ink-600">{t(`offboarding.reasonValue.${process.reason}`)}</td>
                        </tr>
                        {expandedId === process.id && (
                          <tr>
                            <td colSpan={3} className="bg-sand-50 px-3 py-3">
                              <ProcessDetailPanel
                                process={process}
                                canManage={canManage}
                                onCompleted={(runId) => {
                                  setSettlementRunId(runId);
                                  reload();
                                }}
                              />
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

      {!canManage && <Alert tone="info">{t('error.forbidden')}</Alert>}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink-900">{t('offboarding.myTasks')}</h2>
        <MyTasksList listTasks={getMyOffboardingTasks} completeTask={completeOffboardingTask} emptyLabel={t('onboarding.noTasks')} />
      </div>

      {initiating && (
        <Modal title={t('offboarding.initiate')} onClose={() => setInitiating(false)}>
          <InitiateOffboardingForm
            onCancel={() => setInitiating(false)}
            onInitiated={() => {
              setInitiating(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
