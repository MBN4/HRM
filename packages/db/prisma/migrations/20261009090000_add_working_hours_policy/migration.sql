-- CreateEnum
CREATE TYPE "WorkingHoursScope" AS ENUM ('COMPANY', 'TEAM', 'MEMBER');

-- CreateTable
CREATE TABLE "working_hours_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" "WorkingHoursScope" NOT NULL,
    "department_id" UUID,
    "employee_id" UUID,
    "target_key" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "work_hours" DOUBLE PRECISION NOT NULL,
    "break_hours" DOUBLE PRECISION NOT NULL,
    "grace_minutes" INTEGER NOT NULL DEFAULT 15,
    "half_day_threshold_hours" DOUBLE PRECISION,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "working_hours_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "working_hours_policies_tenant_id_scope_idx" ON "working_hours_policies"("tenant_id", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "working_hours_policies_tenant_id_scope_target_key_key" ON "working_hours_policies"("tenant_id", "scope", "target_key");

-- AddForeignKey
ALTER TABLE "working_hours_policies" ADD CONSTRAINT "working_hours_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours_policies" ADD CONSTRAINT "working_hours_policies_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours_policies" ADD CONSTRAINT "working_hours_policies_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security — the identical tenant_isolation pattern every tenant-owned table uses.
GRANT SELECT, INSERT, UPDATE, DELETE ON "working_hours_policies" TO hrm_app;
ALTER TABLE "working_hours_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "working_hours_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "working_hours_policies"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- Step 8.1: backfill the new `working_hours.manage` permission for every EXISTING
-- tenant and grant it to TENANT_ADMIN / CEO / HR_MANAGER (new tenants get it from
-- seedSystemRolesAndPermissions). Idempotent.
INSERT INTO "permissions" ("id", "tenant_id", "key")
SELECT gen_random_uuid(), t."id", 'working_hours.manage'
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."tenant_id" = t."id" AND p."key" = 'working_hours.manage');

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
SELECT r."tenant_id", r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."tenant_id" = r."tenant_id" AND p."key" = 'working_hours.manage'
WHERE r."name" IN ('TENANT_ADMIN', 'CEO', 'HR_MANAGER')
ON CONFLICT DO NOTHING;
