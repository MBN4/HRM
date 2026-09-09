import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { NotificationEventType, SYSTEM_ROLES } from '@hrm/shared';

/**
 * WHO receives a given mapped domain event — the piece of the event ->
 * notification mapping that genuinely needs a database query (unlike
 * `@hrm/shared`'s `DEFAULT_NOTIFICATION_CHANNELS`, which is pure data —
 * see /CLAUDE.md § Conventions → Notifications → Event -> notification
 * mapping). One case per mapped `NotificationEventType`; an event type
 * with no case here (shouldn't happen — `NOTIFICATION_EVENT_TYPES` is the
 * closed set this switch is written against) resolves to no recipients,
 * never a thrown error, since a job that can't determine a recipient
 * should complete quietly rather than dead-letter forever.
 *
 * Always takes an explicit `tx` — this runs from
 * `NotificationsService.handleDomainEvent`, itself invoked from an event
 * listener OUTSIDE any request's `AsyncLocalStorage` context (the whole
 * point is that delivery must not block the triggering request), so it
 * cannot read `TenantContextService.getTx()` the way request-time services
 * do. Same explicit-`tx` pattern `ApproverResolverService`/
 * `WorkflowEscalationService` already use for the same reason.
 */
@Injectable()
export class NotificationRecipientResolverService {
  async resolve(
    tx: Prisma.TransactionClient,
    eventType: NotificationEventType,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    switch (eventType) {
      case 'auth.password_reset_requested':
        return typeof payload.userId === 'string' ? [payload.userId] : [];

      case 'workflow.submitted': {
        const instanceId = payload.instanceId as string;
        const activeSteps = await tx.workflowInstanceStep.findMany({
          where: { instanceId, status: 'ACTIVE' },
        });
        const ids = new Set<string>();
        for (const step of activeSteps) {
          if (step.delegatedToUserId) {
            ids.add(step.delegatedToUserId);
          } else if (step.escalatedToUserId) {
            ids.add(step.escalatedToUserId);
          } else {
            for (const approverId of step.eligibleApproverIds as string[]) {
              ids.add(approverId);
            }
          }
        }
        return [...ids];
      }

      case 'workflow.approved':
      case 'workflow.rejected': {
        const instance = await tx.workflowInstance.findUnique({
          where: { id: payload.instanceId as string },
          select: { requesterId: true },
        });
        return instance ? [instance.requesterId] : [];
      }

      case 'workflow.escalated':
        return typeof payload.escalatedToUserId === 'string' ? [payload.escalatedToUserId] : [];

      case 'performance.cycle_opened': {
        const appraisals = await tx.appraisal.findMany({
          where: { cycleId: payload.cycleId as string },
          select: { employee: { select: { userId: true } } },
        });
        const ids = new Set<string>();
        for (const appraisal of appraisals) {
          if (appraisal.employee.userId) {
            ids.add(appraisal.employee.userId);
          }
        }
        return [...ids];
      }

      case 'performance.review_due':
        return typeof payload.reviewerUserId === 'string' ? [payload.reviewerUserId] : [];

      case 'checklist.task_assigned':
        return typeof payload.assigneeUserId === 'string' ? [payload.assigneeUserId] : [];

      // Step 3.1 — see docs/conventions/operations-modules.md. The
      // current assignee if one is set (a direct payload field, no DB
      // query needed — the SAME shape `workflow.escalated`'s
      // `escalatedToUserId` already uses); otherwise every ACTIVE
      // HR_MANAGER in the tenant, the SAME "no assignee yet, notify the
      // owning role" fallback `licensing.issued`/`.revoked` already
      // establish for TENANT_ADMIN.
      case 'helpdesk.ticket_escalated': {
        if (typeof payload.assignedToUserId === 'string') {
          return [payload.assignedToUserId];
        }
        const hrManagers = await tx.userRole.findMany({
          where: { role: { name: SYSTEM_ROLES.HR_MANAGER }, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        return hrManagers.map((row) => row.userId);
      }

      // Step 3.2 — see docs/conventions/lms.md. All three carry the
      // target userId directly on the payload (resolved by the emitting
      // code, which already has the employee's linked User at hand — the
      // SAME no-DB-query shape `checklist.task_assigned`'s
      // `assigneeUserId` already uses), so no query is needed here either.
      case 'lms.course_assigned':
        return typeof payload.assigneeUserId === 'string' ? [payload.assigneeUserId] : [];

      case 'lms.certification_expiring':
      case 'lms.certification_expired':
        return typeof payload.employeeUserId === 'string' ? [payload.employeeUserId] : [];

      // Step 4.2 — billing state (both good and bad news) is
      // TENANT_ADMIN's job to react to, the SAME "owning role" fallback
      // `licensing.issued`/`.revoked` already establish; billing has no
      // other natural per-user target the way `workflow.submitted`'s
      // approver or `lms.course_assigned`'s assignee do.
      case 'licensing.issued':
      case 'licensing.revoked':
      case 'billing.subscription_activated':
      case 'billing.subscription_past_due':
      case 'billing.subscription_canceled':
      case 'billing.invoice_paid':
      case 'billing.invoice_payment_failed':
      case 'billing.amc_invoice_created': {
        const admins = await tx.userRole.findMany({
          where: { role: { name: SYSTEM_ROLES.TENANT_ADMIN }, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        return admins.map((row) => row.userId);
      }

      // Step 3.5.3 — see docs/conventions/e-signatures.md. Both are
      // direct payload fields, no DB query needed — the SAME shape
      // `workflow.escalated`'s `escalatedToUserId` already uses. An
      // EXTERNAL signer never reaches this resolver at all (see
      // `ExternalSignerNotifierService` — a non-`User` recipient is
      // delivered to directly, bypassing this hub entirely).
      case 'esignature.request_sent':
        return typeof payload.signerUserId === 'string' ? [payload.signerUserId] : [];

      case 'esignature.completed':
        return typeof payload.createdByUserId === 'string' ? [payload.createdByUserId] : [];

      default:
        return [];
    }
  }
}
