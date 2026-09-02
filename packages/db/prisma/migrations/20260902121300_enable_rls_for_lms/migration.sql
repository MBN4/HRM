-- Every LMS table (step 3.2) IS tenant-scoped — ordinary RLS applies,
-- identical `tenant_isolation` policy pattern to every other tenant-owned
-- table in this schema (see docs/conventions/tenancy-rls.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "lms_course_categories",
  "lms_courses",
  "lms_course_content_items",
  "lms_enrollments",
  "lms_content_progress",
  "lms_quizzes",
  "lms_quiz_questions",
  "lms_quiz_attempts",
  "lms_certifications",
  "lms_required_trainings",
  "lms_course_completion_daily_snapshots",
  "lms_training_compliance_daily_snapshots"
  TO hrm_app;

ALTER TABLE "lms_course_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_course_categories" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_courses" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_course_content_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_course_content_items" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_enrollments" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_content_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_content_progress" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_quizzes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_quizzes" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_quiz_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_quiz_questions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_quiz_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_quiz_attempts" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_certifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_certifications" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_required_trainings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_required_trainings" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_course_completion_daily_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_course_completion_daily_snapshots" FORCE ROW LEVEL SECURITY;

ALTER TABLE "lms_training_compliance_daily_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lms_training_compliance_daily_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "lms_course_categories"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_courses"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_course_content_items"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_enrollments"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_content_progress"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_quizzes"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_quiz_questions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_quiz_attempts"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_certifications"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_required_trainings"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_course_completion_daily_snapshots"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON "lms_training_compliance_daily_snapshots"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
