import { Body, Controller, ForbiddenException, Get, Param, Post, UseInterceptors } from '@nestjs/common';
import {
  PERMISSIONS,
  startWorkflowInstanceSchema,
  StartWorkflowInstanceInput,
  workflowStepActionSchema,
  WorkflowStepActionInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { WorkflowEngineService } from './workflow-engine.service';

/**
 * The generic engine's ONLY HTTP surface — see /CLAUDE.md § Conventions →
 * Workflow engine for THE RULE this exists to enforce: leave, expenses,
 * regularizations, offer approvals, and anything else needing an
 * approval chain all consume THESE five routes; no future module should
 * grow its own approve/reject endpoints. Every route requires
 * `workflow.participate` (granted to every seeded system role — see
 * `packages/shared/src/constants/permissions.ts`) as the baseline "may
 * use the workflow system at all" gate; WHICH instances/steps a specific
 * caller may act on is a separate, row-level check the service layer
 * enforces (standing on an instance, eligibility on a step) — the same
 * two-layer shape branch-scoping already established on top of RBAC.
 */
@Controller('workflow')
export class WorkflowController {
  constructor(
    private readonly engine: WorkflowEngineService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('instances')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKFLOW_PARTICIPATE)
  async start(@Body(new ZodValidationPipe(startWorkflowInstanceSchema)) body: StartWorkflowInstanceInput): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId!;
    const callerId = this.tenantContext.userId!;

    let requesterId = callerId;
    if (body.requesterId && body.requesterId !== callerId) {
      if (!this.tenantContext.hasPermission(PERMISSIONS.WORKFLOW_MANAGE)) {
        throw new ForbiddenException('workflow.manage is required to start an instance on behalf of another user.');
      }
      requesterId = body.requesterId;
    }

    return this.engine.startInstance(tx, tenantId, {
      requesterId,
      entityType: body.entityType,
      entityId: body.entityId,
      dataSnapshot: body.dataSnapshot,
    });
  }

  @Get('instances/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKFLOW_PARTICIPATE)
  async getInstance(@Param('id') id: string): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const callerId = this.tenantContext.userId!;
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.WORKFLOW_MANAGE);
    return this.engine.getInstanceDetail(tx, id, callerId, canManage);
  }

  @Post('instances/:id/steps/:stepId/actions')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKFLOW_PARTICIPATE)
  async act(
    @Param('id') instanceId: string,
    @Param('stepId') stepId: string,
    @Body(new ZodValidationPipe(workflowStepActionSchema)) body: WorkflowStepActionInput,
  ): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId!;
    const actorUserId = this.tenantContext.userId!;
    return this.engine.actOnStep(tx, tenantId, instanceId, stepId, actorUserId, body);
  }

  @Post('instances/:id/cancel')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKFLOW_PARTICIPATE)
  async cancel(@Param('id') instanceId: string): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const tenantId = this.tenantContext.getContext().tenantId!;
    const actorUserId = this.tenantContext.userId!;
    const canManage = this.tenantContext.hasPermission(PERMISSIONS.WORKFLOW_MANAGE);
    return this.engine.cancelInstance(tx, tenantId, instanceId, actorUserId, canManage);
  }

  @Get('my-pending-approvals')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.WORKFLOW_PARTICIPATE)
  async myPendingApprovals(): Promise<unknown> {
    const tx = this.tenantContext.getTx();
    const userId = this.tenantContext.userId!;
    return this.engine.myPendingApprovals(tx, userId);
  }
}
