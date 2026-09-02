-- DropIndex
DROP INDEX "lms_enrollments_tenant_id_course_id_employee_id_key";

-- DropIndex
DROP INDEX "lms_enrollments_tenant_id_course_id_idx";

-- CreateIndex
CREATE INDEX "lms_enrollments_tenant_id_course_id_employee_id_idx" ON "lms_enrollments"("tenant_id", "course_id", "employee_id");
