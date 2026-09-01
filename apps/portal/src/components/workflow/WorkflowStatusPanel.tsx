'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { useAuth } from '../../lib/auth/AuthContext';
import { getWorkflowInstance } from '../../lib/api/workflow';
import { ApiError } from '../../lib/api/client';
import { formatDateTime } from '../../lib/format';
import type { WorkflowInstanceDetail, WorkflowInstanceStep } from '../../lib/api/types';
import { PERMISSIONS } from '@hrm/shared';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { StatusBadge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import { Spinner } from '../ui/Spinner';
import { WorkflowActionForm } from './WorkflowActionForm';

/**
 * `GET /workflow/instances/:id` returns the raw DB row for each step,
 * which includes `decidedAt`/`decidedByUserId` — not yet reflected in the
 * portal's `WorkflowInstanceStep` mirror type (see `lib/api/types.ts`,
 * added in an earlier stage). Widened locally here rather than editing
 * that shared type, to keep this stage's edits scoped to the workflow
 * components themselves.
 */
type StepWithDecision = WorkflowInstanceStep & { decidedAt: string | null; decidedByUserId: string | null };

const FORBIDDEN = 'forbidden' as const;
const SKIPPED_FETCH = 'skipped' as const;

/**
 * A reusable, embeddable panel showing a single workflow instance's
 * approval progress — see docs/conventions/workflow.md and the
 * WorkflowStatusPanel section of the admin-console plan. Renders nothing
 * until a module has actually submitted for approval (`workflowInstanceId
 * === null`), fetches the instance itself (catching a 403 — no standing on
 * this instance — into a sentinel BEFORE it reaches `useAsync`, so that
 * hook stays untouched), and — only for the caller eligible to act on the
 * currently `ACTIVE` step — renders the shared `WorkflowActionForm`.
 */
export function WorkflowStatusPanel({ workflowInstanceId }: { workflowInstanceId: string | null }) {
  const { t, locale } = useI18n();
  const { user, can } = useAuth();

  // `workflowInstanceId === null` means the owning module hasn't submitted
  // for approval yet — skip the network call entirely rather than firing a
  // request for a `null` id and discarding the result. `useAsync` itself
  // still runs unconditionally (hooks must never be conditional), it just
  // resolves immediately to a sentinel this component never renders.
  const fetcher = (): Promise<WorkflowInstanceDetail | typeof FORBIDDEN | typeof SKIPPED_FETCH> => {
    if (workflowInstanceId === null) return Promise.resolve(SKIPPED_FETCH);
    return getWorkflowInstance(workflowInstanceId).catch((err) => {
      if (err instanceof ApiError && err.status === 403) return FORBIDDEN;
      throw err;
    });
  };

  const { data, loading, error, reload } = useAsync(fetcher, [workflowInstanceId]);

  if (workflowInstanceId === null || data === SKIPPED_FETCH) {
    return null;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (data === FORBIDDEN) {
    return <Alert tone="info">{t('workflow.noAccess')}</Alert>;
  }

  if (error) {
    return <Alert tone="error">{error}</Alert>;
  }

  if (!data) {
    return null;
  }

  const steps = [...data.steps].sort((a, b) => a.order - b.order) as StepWithDecision[];
  const activeStep = data.steps.find((s) => s.status === 'ACTIVE');
  const eligible =
    (activeStep !== undefined &&
      (activeStep.delegatedToUserId ? activeStep.delegatedToUserId === user?.userId : activeStep.eligibleApproverIds.includes(user?.userId ?? ''))) ||
    can(PERMISSIONS.WORKFLOW_MANAGE);

  return (
    <Card data-testid="workflow-status-panel">
      <CardHeader>
        <CardTitle>{t('workflow.title')}</CardTitle>
        <StatusBadge status={data.instance.status} label={t(`workflow.status.${data.instance.status}`)} />
      </CardHeader>
      <CardBody className="space-y-4">
        <ol className="space-y-2">
          {steps.map((step) => (
            <li key={step.id} data-testid="workflow-step-row" className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ink-700">
                {step.order}. {step.name}
              </span>
              <span className="flex items-center gap-2 text-xs text-ink-400">
                {step.decidedAt && (
                  <span>
                    {formatDateTime(step.decidedAt, locale)}
                    {step.decidedByUserId ? ` · ${step.decidedByUserId}` : ''}
                  </span>
                )}
                <StatusBadge status={step.status} label={t(`workflow.status.${step.status}`)} />
              </span>
            </li>
          ))}
        </ol>

        {activeStep && eligible && (
          <WorkflowActionForm instanceId={data.instance.id} stepId={activeStep.id} onActed={reload} />
        )}
      </CardBody>
    </Card>
  );
}
