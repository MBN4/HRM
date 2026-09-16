'use client';

import { Fragment, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { completeOnboardingTask, getMyOnboardingTasks, getOnboardingProcess, listOnboardingProcesses } from '../../../../lib/api/onboarding';
import { Card, CardBody } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { StatusBadge } from '../../../../components/ui/Badge';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { CreateEmployeeForm } from '../../../../components/onboarding/CreateEmployeeForm';
import { MyTasksList } from '../../../../components/checklists/MyTasksList';
import type { OnboardingProcess } from '../../../../lib/api/types';

function ProcessTasksPanel({ processId }: { processId: string }) {
  const { t } = useI18n();
  const { data: process, loading } = useAsync(() => getOnboardingProcess(processId), [processId]);

  if (loading) return <PageSpinner />;
  const tasks = process?.tasks ?? [];
  if (tasks.length === 0) return <p className="text-sm text-ink-400">{t('common.noData')}</p>;

  return (
    <ul className="space-y-1">
      {tasks.map((task) => (
        <li key={task.id} data-testid="onboarding-process-task-row" className="flex items-center justify-between text-sm">
          <span className="text-ink-700">
            {task.title} <span className="text-ink-400">({task.category})</span>
          </span>
          <StatusBadge status={task.status} label={task.status} />
        </li>
      ))}
    </ul>
  );
}

export default function OnboardingPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.ONBOARDING_MANAGE);

  const { data: processes, loading, reload } = useAsync(() => (canManage ? listOnboardingProcesses() : Promise.resolve([])), [canManage]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('nav.onboarding')}</h1>
        {canManage && (
          <Button data-testid="refresh-button" variant="secondary" size="sm" aria-label={t('common.refresh')} onClick={() => reload()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>

      {canManage && (
        <Card>
          <CardBody>
            {loading ? (
              <PageSpinner />
            ) : !processes || processes.length === 0 ? (
              <EmptyState title={t('onboarding.noProcesses')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-2 text-start font-medium">{t('common.status')}</th>
                      <th className="py-2 text-start font-medium">{t('common.employee')}</th>
                      <th className="py-2 text-start font-medium">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {processes.map((process: OnboardingProcess) => (
                      <Fragment key={process.id}>
                        <tr data-testid="onboarding-process-row" data-status={process.status} data-candidate-id={process.candidateId}>
                          <td className="py-2.5">
                            <button type="button" className="hover:underline" onClick={() => setExpandedId(expandedId === process.id ? null : process.id)}>
                              <StatusBadge status={process.status} label={t(`onboarding.status.${process.status}`)} />
                            </button>
                          </td>
                          <td className="py-2.5 text-ink-600">{process.employeeId ?? process.candidateId}</td>
                          <td className="py-2.5">
                            {process.status === 'IN_PROGRESS' && (
                              <Button data-testid="create-employee-button" size="sm" onClick={() => setCreatingFor(process.id)}>
                                {t('onboarding.createEmployee')}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {expandedId === process.id && (
                          <tr>
                            <td colSpan={3} className="bg-sand-50 px-3 py-3">
                              <ProcessTasksPanel processId={process.id} />
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
        <h2 className="mb-2 text-sm font-semibold text-ink-900">{t('onboarding.myTasks')}</h2>
        <MyTasksList listTasks={getMyOnboardingTasks} completeTask={completeOnboardingTask} emptyLabel={t('onboarding.noTasks')} />
      </div>

      {creatingFor && (
        <Modal title={t('onboarding.createEmployee')} onClose={() => setCreatingFor(null)}>
          <CreateEmployeeForm
            processId={creatingFor}
            onCancel={() => setCreatingFor(null)}
            onCreated={() => {
              setCreatingFor(null);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
