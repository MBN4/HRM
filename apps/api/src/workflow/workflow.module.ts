import { Module } from '@nestjs/common';
import { ApproverResolverService } from './approver-resolver.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowEscalationService } from './workflow-escalation.service';

@Module({
  controllers: [WorkflowController],
  providers: [ApproverResolverService, WorkflowEngineService, WorkflowEscalationService],
  exports: [WorkflowEngineService, WorkflowEscalationService, ApproverResolverService],
})
export class WorkflowModule {}
