import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AttendanceRegularization, AttendanceSource, Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { resolveAttendancePackConfig } from '../attendance-country-pack.util';
import { computeRecordMetrics } from '../attendance-metrics.util';
import { ATTENDANCE_REGULARIZATION_ENTITY_TYPE } from '../attendance.constants';
import { ShiftResolutionService } from '../shifts/shift-resolution.service';
import { AttendanceSummaryService } from '../summary/attendance-summary.service';
import { WORKFLOW_EVENTS } from '../../workflow/workflow-events';

interface WorkflowTerminalPayload {
  tenantId: string;
  instanceId: string;
  entityType?: string;
  entityId?: string;
}

const MANUAL_SOURCE: AttendanceSource = 'MANUAL';

/**
 * THE RULE in action (docs/conventions/workflow.md): this module never
 * builds its own approve/reject/cancel logic — a regularization's ONLY
 * connection to the workflow engine is `AttendanceRegularizationService.
 * submit`'s `startInstance` call and this listener, which reacts to the
 * engine's own `workflow.approved`/`workflow.rejected`/`workflow.canceled`
 * events (filtered to `entityType === "AttendanceRegularization"`) to apply
 * the one attendance-specific side-effect the generic engine has no way to
 * know about: mutating the actual `AttendanceRecord`.
 *
 * Runs OUTSIDE any HTTP request — the SAME fire-and-forget asynchronous-
 * dispatch shape `LeaveWorkflowEventsListener` (1.2) already documents for
 * itself — so this opens its OWN `withTenantContext` transaction and never
 * throws (logs and swallows): the mutation this event describes already
 * happened and already returned a response to its caller. Guarded by
 * `AttendanceRegularization.status !== 'PENDING'` against a
 * (re)delivered event ever being applied twice, the same guard
 * `LeaveWorkflowEventsListener` uses via `LeaveRequest.balanceApplied`.
 */
@Injectable()
export class AttendanceRegularizationWorkflowEventsListener {
  private readonly logger = new Logger(AttendanceRegularizationWorkflowEventsListener.name);

  constructor(
    private readonly shiftResolution: ShiftResolutionService,
    private readonly summary: AttendanceSummaryService,
  ) {}

  @OnEvent(WORKFLOW_EVENTS.APPROVED)
  handleApproved(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'APPROVED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.REJECTED)
  handleRejected(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'REJECTED').catch((error: unknown) => this.logError(payload, error));
  }

  @OnEvent(WORKFLOW_EVENTS.CANCELED)
  handleCanceled(payload: WorkflowTerminalPayload): void {
    this.handle(payload, 'CANCELED').catch((error: unknown) => this.logError(payload, error));
  }

  private async handle(payload: WorkflowTerminalPayload, status: 'APPROVED' | 'REJECTED' | 'CANCELED'): Promise<void> {
    if (payload.entityType !== ATTENDANCE_REGULARIZATION_ENTITY_TYPE || !payload.entityId) {
      return;
    }

    await withTenantContext(payload.tenantId, async (tx: Prisma.TransactionClient) => {
      const row = await tx.attendanceRegularization.findUnique({ where: { id: payload.entityId } });
      if (!row || row.status !== 'PENDING') {
        return;
      }

      if (status !== 'APPROVED') {
        await tx.attendanceRegularization.update({ where: { id: row.id }, data: { status, decidedAt: new Date() } });
        return;
      }

      const attendanceRecordId = await this.applyCorrection(tx, payload.tenantId, row);
      await tx.attendanceRegularization.update({
        where: { id: row.id },
        data: { status: 'APPROVED', decidedAt: new Date(), attendanceRecordId },
      });

      this.summary.enqueueRecompute(payload.tenantId, row.workDate, undefined, row.employeeId).catch(() => undefined);
    });
  }

  /** Returns the id of the `AttendanceRecord` the approved correction ended up applied to (existing or newly created). */
  private async applyCorrection(tx: Prisma.TransactionClient, tenantId: string, row: AttendanceRegularization): Promise<string> {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: row.employeeId } });
    const branch = await tx.branch.findUniqueOrThrow({ where: { id: employee.branchId } });
    const pack = await resolveAttendancePackConfig(tx, tenantId, employee.branchId);

    if (row.attendanceRecordId) {
      const existing = await tx.attendanceRecord.findFirstOrThrow({ where: { id: row.attendanceRecordId } });
      const clockInAt = row.requestedClockInAt ?? existing.clockInAt;
      const clockOutAt = row.requestedClockOutAt ?? existing.clockOutAt;
      const shift = existing.shiftDefinitionId ? await tx.shiftDefinition.findUnique({ where: { id: existing.shiftDefinitionId } }) : null;

      const metrics = clockOutAt
        ? computeRecordMetrics({ clockInAt, clockOutAt, workDate: existing.workDate, timeZone: branch.timezone, shift, overtimeRules: pack.overtimeRules })
        : null;

      await tx.attendanceRecord.update({
        where: { id_workDate: { id: existing.id, workDate: existing.workDate } },
        data: {
          clockInAt,
          clockOutAt,
          status: clockOutAt ? 'CLOSED' : 'OPEN',
          workedMinutes: metrics?.workedMinutes ?? null,
          overtimeMinutes: metrics?.overtimeMinutes ?? 0,
          lateMinutes: metrics?.lateMinutes ?? 0,
          ...(row.requestedClockInAt ? { clockInSource: MANUAL_SOURCE } : {}),
          ...(row.requestedClockOutAt ? { clockOutSource: MANUAL_SOURCE } : {}),
        },
      });
      return existing.id;
    }

    // No existing record at all — a fully missing punch. `requestedClockInAt`
    // is guaranteed present (enforced at submit time).
    const clockInAt = row.requestedClockInAt!;
    const clockOutAt = row.requestedClockOutAt ?? null;
    const shift = await this.shiftResolution.resolveForDate(tx, employee.id, row.workDate);
    const metrics = clockOutAt
      ? computeRecordMetrics({ clockInAt, clockOutAt, workDate: row.workDate, timeZone: branch.timezone, shift, overtimeRules: pack.overtimeRules })
      : null;

    const created = await tx.attendanceRecord.create({
      data: {
        tenantId,
        employeeId: employee.id,
        branchId: employee.branchId,
        workDate: row.workDate,
        shiftDefinitionId: shift?.id ?? null,
        clockInAt,
        clockInSource: MANUAL_SOURCE,
        clockOutAt,
        clockOutSource: clockOutAt ? MANUAL_SOURCE : null,
        status: clockOutAt ? 'CLOSED' : 'OPEN',
        workedMinutes: metrics?.workedMinutes ?? null,
        overtimeMinutes: metrics?.overtimeMinutes ?? 0,
        lateMinutes: metrics?.lateMinutes ?? 0,
      },
    });
    return created.id;
  }

  private logError(payload: WorkflowTerminalPayload, error: unknown): void {
    this.logger.error(`Failed to apply attendance regularization for instance "${payload.instanceId}": ${String(error)}`);
  }
}
