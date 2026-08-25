import { Module } from '@nestjs/common';
import { ApproverResolverService } from './approver-resolver.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowEscalationService } from './workflow-escalation.service';
import { WorkflowEventsListener } from './listeners/workflow-events.listener';

@Module({
  controllers: [WorkflowController],
  providers: [ApproverResolverService, WorkflowEngineService, WorkflowEscalationService, WorkflowEventsListener],
  exports: [WorkflowEngineService, WorkflowEscalationService, ApproverResolverService],
})
export class WorkflowModule {}
