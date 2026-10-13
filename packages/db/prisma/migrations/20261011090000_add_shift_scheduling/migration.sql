-- Step 8.2 — Shift scheduling & rostering. Additive over 1.3's ShiftDefinition /
-- RosterAssignment and 8.1's WorkingHoursPolicy; see docs/conventions/shift-scheduling.md.

-- ---------------------------------------------------------------------------
-- ShiftDefinition: now also the named carrier of the working-hours parameters.
-- ---------------------------------------------------------------------------
ALTER TABLE "shift_definitions"
  ADD COLUMN "grace_minutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "half_day_threshold_hours" DOUBLE PRECISION,
  ADD COLUMN "color" VARCHAR(7),
  ADD COLUMN "min_staffing" INTEGER;

-- ---------------------------------------------------------------------------
-- WorkingHoursPolicy: a row may now be a STANDING SHIFT assignment (hours come
-- live from the shift) OR a full custom set — never a mix, never neither.
-- ---------------------------------------------------------------------------
ALTER TABLE "working_hours_policies"
  ADD COLUMN "shift_definition_id" UUID,
  ALTER COLUMN "start_time" DROP NOT NULL,
  ALTER COLUMN "work_hours" DROP NOT NULL,
  ALTER COLUMN "break_hours" DROP NOT NULL;

ALTER TABLE "working_hours_policies" ADD CONSTRAINT "working_hours_policies_shift_xor_custom_check" CHECK (
  ("shift_definition_id" IS NOT NULL AND "start_time" IS NULL AND "work_hours" IS NULL AND "break_hours" IS NULL)
  OR
  ("shift_definition_id" IS NULL AND "start_time" IS NOT NULL AND "work_hours" IS NOT NULL AND "break_hours" IS NOT NULL)
);

ALTER TABLE "working_hours_policies" ADD CONSTRAINT "working_hours_policies_tenant_id_shift_definition_id_fkey"
  FOREIGN KEY ("tenant_id", "shift_definition_id") REFERENCES "shift_definitions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "working_hours_policies_tenant_id_shift_definition_id_idx" ON "working_hours_policies"("tenant_id", "shift_definition_id");

-- ---------------------------------------------------------------------------
-- RosterAssignment: dated "cells" with a DRAFT/PUBLISHED lifecycle + day-off.
-- Every pre-existing row is a live (PUBLISHED) assignment.
-- ---------------------------------------------------------------------------
CREATE TYPE "RosterAssignmentStatus" AS ENUM ('DRAFT', 'PUBLISHED');

ALTER TABLE "roster_assignments"
  ADD COLUMN "day_off" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "status" "RosterAssignmentStatus" NOT NULL DEFAULT 'PUBLISHED',
  ADD COLUMN "published_at" TIMESTAMP(3),
  ADD COLUMN "created_by_user_id" UUID,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "shift_definition_id" DROP NOT NULL;

-- A cell is EITHER a shift OR a day off.
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_shift_xor_day_off_check" CHECK (
  ("day_off" = true AND "shift_definition_id" IS NULL) OR ("day_off" = false AND "shift_definition_id" IS NOT NULL)
);

-- At most ONE single-day cell per employee per date (the calendar's invariant;
-- legacy multi-day ranges are unaffected). Prisma's DSL can't express a partial unique index.
CREATE UNIQUE INDEX "roster_assignments_single_day_cell_key"
  ON "roster_assignments"("tenant_id", "employee_id", "effective_from")
  WHERE "effective_to" = "effective_from";

CREATE INDEX "roster_assignments_tenant_id_effective_from_effective_to_idx"
  ON "roster_assignments"("tenant_id", "effective_from", "effective_to");

-- ---------------------------------------------------------------------------
-- ShiftSwapRequest
-- ---------------------------------------------------------------------------
CREATE TYPE "ShiftSwapStatus" AS ENUM ('AWAITING_PEER', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DECLINED', 'CANCELED');

CREATE TABLE "shift_swap_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requester_employee_id" UUID NOT NULL,
    "counterpart_employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "requester_shift_id" UUID,
    "counterpart_shift_id" UUID,
    "reason" TEXT,
    "status" "ShiftSwapStatus" NOT NULL DEFAULT 'AWAITING_PEER',
    "workflow_instance_id" UUID,
    "peer_responded_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_swap_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shift_swap_requests_tenant_id_id_key" ON "shift_swap_requests"("tenant_id", "id");
CREATE INDEX "shift_swap_requests_tenant_id_requester_employee_id_status_idx" ON "shift_swap_requests"("tenant_id", "requester_employee_id", "status");
CREATE INDEX "shift_swap_requests_tenant_id_counterpart_employee_id_stat_idx" ON "shift_swap_requests"("tenant_id", "counterpart_employee_id", "status");

ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenant_id_requester_employee_id_fkey" FOREIGN KEY ("tenant_id", "requester_employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenant_id_counterpart_employee_id_fkey" FOREIGN KEY ("tenant_id", "counterpart_employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenant_id_requester_shift_id_fkey" FOREIGN KEY ("tenant_id", "requester_shift_id") REFERENCES "shift_definitions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_tenant_id_counterpart_shift_id_fkey" FOREIGN KEY ("tenant_id", "counterpart_shift_id") REFERENCES "shift_definitions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — the identical tenant_isolation pattern every tenant-owned table uses.
GRANT SELECT, INSERT, UPDATE, DELETE ON "shift_swap_requests" TO hrm_app;
ALTER TABLE "shift_swap_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shift_swap_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shift_swap_requests"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- ---------------------------------------------------------------------------
-- Permission `scheduling.manage`: backfill for every EXISTING tenant and grant
-- to TENANT_ADMIN / CEO / HR_MANAGER / MANAGER (new tenants get it from
-- seedSystemRolesAndPermissions). Idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "tenant_id", "key")
SELECT gen_random_uuid(), t."id", 'scheduling.manage'
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."tenant_id" = t."id" AND p."key" = 'scheduling.manage');

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'scheduling.manage'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER', 'MANAGER')
ON CONFLICT DO NOTHING;
