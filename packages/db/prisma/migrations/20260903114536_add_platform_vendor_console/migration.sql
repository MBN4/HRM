-- CreateEnum
CREATE TYPE "TenantProvisionMode" AS ENUM ('SHARED_DB', 'DB_PER_TENANT');

-- CreateEnum
CREATE TYPE "PlatformRoleName" AS ENUM ('PLATFORM_OWNER', 'PLATFORM_SUPPORT');

-- CreateEnum
CREATE TYPE "PlatformAdminStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "provision_mode" "TenantProvisionMode" NOT NULL DEFAULT 'SHARED_DB';

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashed_password" TEXT NOT NULL,
    "role" "PlatformRoleName" NOT NULL,
    "status" "PlatformAdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfa_secret_encrypted" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_recovery_codes_hashed" JSONB,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "platform_admin_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform_admin_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "target_tenant_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id","occurred_at")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "impersonation_sessions_tenant_id_target_user_id_idx" ON "impersonation_sessions"("tenant_id", "target_user_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_platform_admin_id_started_at_idx" ON "impersonation_sessions"("platform_admin_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_tenant_id_id_key" ON "impersonation_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "platform_audit_log_occurred_at_idx" ON "platform_audit_log"("occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_platform_admin_id_occurred_at_idx" ON "platform_audit_log"("platform_admin_id", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_target_tenant_id_occurred_at_idx" ON "platform_audit_log"("target_tenant_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_target_user_id_fkey" FOREIGN KEY ("tenant_id", "target_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 4.1 — `impersonation_sessions` IS tenant-scoped (it targets a real
-- tenant User): ordinary RLS applies, identical `tenant_isolation` policy
-- pattern to every other tenant-owned table in this schema. See
-- docs/conventions/tenancy-rls.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON "impersonation_sessions" TO hrm_app;

ALTER TABLE "impersonation_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "impersonation_sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "impersonation_sessions"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);

-- `platform_admins`/`platform_audit_log` are DELIBERATELY given NO grant to
-- `hrm_app` at all (stricter than CountryPack's read-only grant) and NO RLS
-- policy — they are not tenant-scoped, and no tenant-scoped request path
-- ever needs to read platform identity or the platform audit trail. Every
-- access goes through the owner `prisma` client on the audited
-- @PlatformRoute() path only. Postgres's default-deny (no grant = no
-- access for any other role) is sufficient; nothing to revoke since
-- nothing was ever granted.
