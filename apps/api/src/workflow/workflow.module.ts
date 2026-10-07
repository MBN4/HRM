import { Module } from '@nestjs/common';
import { ApproverResolverService } from './approver-resolver.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowEscalationService } from './workflow-escalation.service';
import { WorkflowRoutingService } from './workflow-routing.service';

@Module({
  controllers: [WorkflowController],
  providers: [ApproverResolverService, WorkflowEngineService, WorkflowEscalationService, WorkflowRoutingService],
  exports: [WorkflowEngineService, WorkflowEscalationService, ApproverResolverService, WorkflowRoutingService],
})
export class WorkflowModule {}
