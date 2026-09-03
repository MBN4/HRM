-- CreateEnum
CREATE TYPE "WebhookSubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "SsoProtocol" AS ENUM ('OIDC', 'SAML');

-- CreateEnum
CREATE TYPE "BiometricDeviceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'SLACK';

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "bank_export_format" VARCHAR(32);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "event_types" TEXT[],
    "status" "WebhookSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "signing_secret_encrypted" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "webhook_subscription_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_response_status" INTEGER,
    "last_response_body" TEXT,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "hashed_key" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "rate_limit_per_minute" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "protocol" "SsoProtocol" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_device_registrations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashed_secret" TEXT NOT NULL,
    "status" "BiometricDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_device_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_workspace_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "webhook_url_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_workspace_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_subscriptions_tenant_id_status_idx" ON "webhook_subscriptions"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscriptions_tenant_id_id_key" ON "webhook_subscriptions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_webhook_subscription_id_create_idx" ON "webhook_deliveries"("tenant_id", "webhook_subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_status_idx" ON "webhook_deliveries"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_status_idx" ON "api_keys"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_tenant_id_key_prefix_key" ON "api_keys"("tenant_id", "key_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "sso_configs_tenant_id_key" ON "sso_configs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_device_registrations_tenant_id_device_id_key" ON "biometric_device_registrations"("tenant_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "slack_workspace_configs_tenant_id_key" ON "slack_workspace_configs"("tenant_id");

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_webhook_subscription_id_fkey" FOREIGN KEY ("tenant_id", "webhook_subscription_id") REFERENCES "webhook_subscriptions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_configs" ADD CONSTRAINT "sso_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_device_registrations" ADD CONSTRAINT "biometric_device_registrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_workspace_configs" ADD CONSTRAINT "slack_workspace_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
