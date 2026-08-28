import { getMyPendingApprovals, getWorkflowInstance } from './workflow';
import { listEmployees } from './employees';
import type { Employee, WorkflowInstanceDetail, WorkflowInstanceStep } from './types';

export interface PendingApproval {
  step: WorkflowInstanceStep;
  detail: WorkflowInstanceDetail;
  employee: Employee | null;
}

/**
 * `GET /workflow/my-pending-approvals` returns bare steps with no
 * entity/requester context (see docs/conventions/workflow.md's own
 * "known scaling tradeoff" note) — this stitches in each step's parent
 * instance (for `entityType`/`dataSnapshot`) and a best-effort employee
 * name (matched via `dataSnapshot.employeeId` against one bounded page of
 * the tenant's employees, since there's no batch "resolve these ids"
 * endpoint). A documented, accepted simplification for a typical
 * approvals-inbox volume — not a scan of the whole tenant on every poll.
 */
export async function loadPendingApprovals(): Promise<PendingApproval[]> {
  const steps = await getMyPendingApprovals();
  if (steps.length === 0) return [];

  const uniqueInstanceIds = Array.from(new Set(steps.map((s) => s.instanceId)));
  const details = await Promise.all(uniqueInstanceIds.map((id) => getWorkflowInstance(id)));
  const detailByInstanceId = new Map(details.map((d) => [d.instance.id, d]));

  const employeePage = await listEmployees({ pageSize: 100 });
  const employeeById = new Map(employeePage.data.map((e) => [e.id, e]));

  return steps.map((step) => {
    const detail = detailByInstanceId.get(step.instanceId)!;
    const employeeId = detail.instance.dataSnapshot.employeeId as string | undefined;
    return { step, detail, employee: employeeId ? (employeeById.get(employeeId) ?? null) : null };
  });
}
