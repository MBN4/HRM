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

      case 'licensing.issued':
      case 'licensing.revoked': {
        const admins = await tx.userRole.findMany({
          where: { role: { name: SYSTEM_ROLES.TENANT_ADMIN }, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        return admins.map((row) => row.userId);
      }

      default:
        return [];
    }
  }
}
