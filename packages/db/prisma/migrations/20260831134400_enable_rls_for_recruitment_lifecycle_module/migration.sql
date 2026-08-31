-- Every Recruitment/Onboarding/Offboarding table (step 2.3) IS
-- tenant-scoped — ordinary RLS applies, identical `tenant_isolation`
-- policy pattern to every other tenant-owned table in this schema (see
-- docs/conventions/tenancy-rls.md). This includes `candidates`/
-- `applications`/etc. even though they're reachable from the PUBLIC
-- careers API — that route is `@AllowAnonymous()` (tenant resolved, JWT
-- skipped), never `@Public()` (no tenant at all), so it still runs inside
-- a real tenant-scoped transaction and RLS still applies exactly as it
-- does to every authenticated route — see
-- docs/conventions/recruitment-lifecycle.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "job_requisitions",
  "job_postings",
  "candidates",
  "applications",
  "interviews",
  "interview_scorecards",
  "offers",
  "onboarding_processes",
  "offboarding_processes",
  "checklist_templates",
  "checklist_task_instances"
  TO hrm_app;

ALTER TABLE "job_requisitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_requisitions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "job_postings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_postings" FORCE ROW LEVEL SECURITY;

ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;

ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interviews" FORCE ROW LEVEL SECURITY;

ALTER TABLE "interview_scorecards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_scorecards" FORCE ROW LEVEL SECURITY;

ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "onboarding_processes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "onboarding_processes" FORCE ROW LEVEL SECURITY;

ALTER TABLE "offboarding_processes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offboarding_processes" FORCE ROW LEVEL SECURITY;

ALTER TABLE "checklist_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "checklist_templates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "checklist_task_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "checklist_task_instances" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "job_requisitions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "job_postings"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "candidates"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "applications"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "interviews"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "interview_scorecards"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "offers"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "onboarding_processes"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "offboarding_processes"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "checklist_templates"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "checklist_task_instances"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
