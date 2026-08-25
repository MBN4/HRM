-- CreateEnum
CREATE TYPE "WorkflowInstanceStatus" AS ENUM ('PENDING', 'IN_STEP', 'APPROVED', 'REJECTED', 'CANCELED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'SKIPPED', 'ACTIVE', 'APPROVED', 'REJECTED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "WorkflowActionType" AS ENUM ('APPROVE', 'REJECT', 'DELEGATE', 'COMMENT', 'ESCALATE', 'AUTO_APPROVE', 'CANCEL');

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "head_user_id" UUID;

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "head_user_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "manager_id" UUID;

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "approver_rule" JSONB NOT NULL,
    "condition" JSONB,
    "auto_approve_condition" JSONB,
    "escalation_after_minutes" INTEGER,
    "escalation_rule" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "requester_id" UUID NOT NULL,
    "data_snapshot" JSONB NOT NULL,
    "status" "WorkflowInstanceStatus" NOT NULL DEFAULT 'PENDING',
    "current_order" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instance_steps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "template_step_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "status" "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
    "eligible_approver_ids" JSONB NOT NULL,
    "delegated_to_user_id" UUID,
    "escalated_to_user_id" UUID,
    "activated_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" UUID,

    CONSTRAINT "workflow_instance_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "instance_step_id" UUID,
    "action_type" "WorkflowActionType" NOT NULL,
    "actor_user_id" UUID,
    "delegated_to_user_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_templates_tenant_id_entity_type_is_active_idx" ON "workflow_templates"("tenant_id", "entity_type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_tenant_id_id_key" ON "workflow_templates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_tenant_id_entity_type_version_key" ON "workflow_templates"("tenant_id", "entity_type", "version");

-- CreateIndex
CREATE INDEX "workflow_steps_tenant_id_template_id_order_idx" ON "workflow_steps"("tenant_id", "template_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_tenant_id_id_key" ON "workflow_steps"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "workflow_instances_tenant_id_entity_type_entity_id_idx" ON "workflow_instances"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "workflow_instances_tenant_id_requester_id_status_idx" ON "workflow_instances"("tenant_id", "requester_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_instances_tenant_id_id_key" ON "workflow_instances"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "workflow_instance_steps_tenant_id_instance_id_order_idx" ON "workflow_instance_steps"("tenant_id", "instance_id", "order");

-- CreateIndex
CREATE INDEX "workflow_instance_steps_tenant_id_status_due_at_idx" ON "workflow_instance_steps"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_instance_steps_tenant_id_id_key" ON "workflow_instance_steps"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "workflow_actions_tenant_id_instance_id_idx" ON "workflow_actions"("tenant_id", "instance_id");

-- CreateIndex
CREATE INDEX "branches_tenant_id_head_user_id_idx" ON "branches"("tenant_id", "head_user_id");

-- CreateIndex
CREATE INDEX "departments_tenant_id_head_user_id_idx" ON "departments"("tenant_id", "head_user_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_manager_id_idx" ON "users"("tenant_id", "manager_id");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_head_user_id_fkey" FOREIGN KEY ("tenant_id", "head_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_head_user_id_fkey" FOREIGN KEY ("tenant_id", "head_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_manager_id_fkey" FOREIGN KEY ("tenant_id", "manager_id") REFERENCES "users"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "workflow_templates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "workflow_templates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_tenant_id_requester_id_fkey" FOREIGN KEY ("tenant_id", "requester_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance_steps" ADD CONSTRAINT "workflow_instance_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance_steps" ADD CONSTRAINT "workflow_instance_steps_tenant_id_instance_id_fkey" FOREIGN KEY ("tenant_id", "instance_id") REFERENCES "workflow_instances"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance_steps" ADD CONSTRAINT "workflow_instance_steps_tenant_id_template_step_id_fkey" FOREIGN KEY ("tenant_id", "template_step_id") REFERENCES "workflow_steps"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_tenant_id_instance_id_fkey" FOREIGN KEY ("tenant_id", "instance_id") REFERENCES "workflow_instances"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_tenant_id_instance_step_id_fkey" FOREIGN KEY ("tenant_id", "instance_step_id") REFERENCES "workflow_instance_steps"("tenant_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;
