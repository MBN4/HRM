-- Analytics dashboard module (step 1.5). Four tenant-scoped rollup
-- tables — identical `tenant_isolation` policy pattern to every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
-- See docs/conventions/analytics-dashboard.md for what these tables hold
-- and why they exist (precomputed rollups, never a live aggregate over
-- employees/attendance_records/leave_requests/leave_balances).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "headcount_daily_snapshots",
  "workforce_movement_daily_counts",
  "attendance_daily_branch_summaries",
  "leave_utilization_daily_snapshots"
  TO hrm_app;

ALTER TABLE "headcount_daily_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "headcount_daily_snapshots" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workforce_movement_daily_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce_movement_daily_counts" FORCE ROW LEVEL SECURITY;

ALTER TABLE "attendance_daily_branch_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_daily_branch_summaries" FORCE ROW LEVEL SECURITY;

ALTER TABLE "leave_utilization_daily_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_utilization_daily_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "headcount_daily_snapshots"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "workforce_movement_daily_counts"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "attendance_daily_branch_summaries"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "leave_utilization_daily_snapshots"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
