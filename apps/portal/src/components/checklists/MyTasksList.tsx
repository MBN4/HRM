'use client';

import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { Card, CardBody } from '../ui/Card';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { EmptyState } from '../ui/EmptyState';
import { PageSpinner } from '../ui/Spinner';
import type { ChecklistTaskInstance } from '../../lib/api/types';

/**
 * Shared "my checklist tasks" list — used verbatim by both the Onboarding
 * and Offboarding consoles (see docs/conventions/recruitment-lifecycle.md's
 * shared checklist mini-engine). Ungated on any permission: a checklist
 * task can land on ANY authenticated user (`ChecklistAssigneeRule` can
 * resolve to any user in the tenant), so this section renders for whoever
 * is logged in, independent of `onboarding.manage`/`offboarding.manage`.
 */
export function MyTasksList({
  listTasks,
  completeTask,
  emptyLabel,
}: {
  listTasks: () => Promise<ChecklistTaskInstance[]>;
  completeTask: (id: string, document?: File | null) => Promise<ChecklistTaskInstance>;
  emptyLabel: string;
}) {
  const { t } = useI18n();
  const { data: tasks, loading, reload } = useAsync(listTasks, []);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleComplete(task: ChecklistTaskInstance) {
    setBusyId(task.id);
    setError(null);
    try {
      await completeTask(task.id, files[task.id] ?? null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardBody>
        {error && (
          <div className="mb-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        {loading ? (
          <PageSpinner />
        ) : !tasks || tasks.length === 0 ? (
          <EmptyState title={emptyLabel} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {tasks.map((task) => (
              <li key={task.id} data-testid="checklist-task-row" className="space-y-2 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-800">{task.title}</p>
                    <p className="text-xs text-ink-400">
                      {task.category}
                      {task.requiresDocument ? ` · ${t('onboarding.requiresDocument')}` : ''}
                    </p>
                  </div>
                  <Button
                    data-testid="complete-task-button"
                    size="sm"
                    loading={busyId === task.id}
                    disabled={task.requiresDocument && !files[task.id]}
                    onClick={() => handleComplete(task)}
                  >
                    {t('onboarding.completeTask')}
                  </Button>
                </div>
                {task.requiresDocument && (
                  <input
                    type="file"
                    data-testid="task-document-input"
                    onChange={(e) => setFiles((current) => ({ ...current, [task.id]: e.target.files?.[0] ?? null }))}
                    className="block text-sm text-ink-600"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
