-- Attendance & time-tracking module (step 1.3). Five tenant-scoped
-- tables — identical `tenant_isolation` policy pattern to every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
-- `attendance_records` additionally carries a composite PRIMARY KEY
-- (id, work_date) rather than a bare `id` PK — PARTITION-READY, not yet
-- partitioned, the SAME shape `audit_log` already established in 0.9 (see
-- docs/conventions/attendance.md) — this migration only adds RLS, it does
-- not touch that shape.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "shift_definitions",
  "roster_assignments",
  "attendance_records",
  "attendance_regularizations",
  "attendance_daily_summaries"
  TO hrm_app;

ALTER TABLE "shift_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shift_definitions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "roster_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roster_assignments" FORCE ROW LEVEL SECURITY;

ALTER TABLE "attendance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_records" FORCE ROW LEVEL SECURITY;

ALTER TABLE "attendance_regularizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_regularizations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "attendance_daily_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_daily_summaries" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "shift_definitions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "roster_assignments"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "attendance_records"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "attendance_regularizations"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "attendance_daily_summaries"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
