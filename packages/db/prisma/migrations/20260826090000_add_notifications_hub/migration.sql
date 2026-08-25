-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD_LETTER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "preferred_language" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "rendered_subject" TEXT,
    "rendered_body" TEXT,
    "sent_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_recipient_user_id_created_at_idx" ON "notifications"("tenant_id", "recipient_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_id_key" ON "notifications"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenant_id_notification_id_idx" ON "notification_deliveries"("tenant_id", "notification_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenant_id_status_idx" ON "notification_deliveries"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_tenant_id_id_key" ON "notification_deliveries"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notification_preferences_tenant_id_user_id_idx" ON "notification_preferences"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenant_id_user_id_event_type_chann_key" ON "notification_preferences"("tenant_id", "user_id", "event_type", "channel");

-- CreateIndex
CREATE INDEX "notification_templates_event_type_channel_locale_is_active_idx" ON "notification_templates"("event_type", "channel", "locale", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_event_type_channel_locale_version_key" ON "notification_templates"("event_type", "channel", "locale", "version");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_notification_id_fkey" FOREIGN KEY ("tenant_id", "notification_id") REFERENCES "notifications"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

