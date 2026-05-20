-- CreateEnum
CREATE TYPE "access_method" AS ENUM ('pin', 'qr', 'rfid');

-- CreateEnum
CREATE TYPE "access_credential_status" AS ENUM ('pending', 'active', 'suspended', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "access_device_type" AS ENUM ('door', 'unit_lock', 'gate', 'other');

-- CreateEnum
CREATE TYPE "access_result" AS ENUM ('allowed', 'denied_invalid_credential', 'denied_inactive_credential', 'denied_outside_hours', 'denied_wrong_facility', 'denied_dunning', 'denied_unknown', 'error');


-- CreateTable
CREATE TABLE "access_credentials" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "method" "access_method" NOT NULL,
    "status" "access_credential_status" NOT NULL DEFAULT 'pending',
    "label" TEXT,
    "secret_hash" TEXT,
    "secret_preview" TEXT,
    "rfid_uid" TEXT,
    "allowed_facility_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_unit_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_hours" JSONB NOT NULL DEFAULT '{}',
    "suspend_reason" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "contract_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "access_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_devices" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "unit_id" UUID,
    "type" "access_device_type" NOT NULL,
    "name" TEXT NOT NULL,
    "hardware_id" TEXT NOT NULL,
    "api_key_hash" TEXT,
    "api_key_preview" TEXT,
    "mqtt_topic" TEXT,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "access_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "device_id" UUID,
    "credential_id" UUID,
    "customer_id" UUID,
    "method" "access_method" NOT NULL,
    "result" "access_result" NOT NULL,
    "attempted_value" TEXT,
    "reason" TEXT,
    "ip_address" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_credentials_tenant_id_idx" ON "access_credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "access_credentials_tenant_id_status_idx" ON "access_credentials"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "access_credentials_tenant_id_customer_id_idx" ON "access_credentials"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "access_credentials_rfid_uid_idx" ON "access_credentials"("rfid_uid");

-- CreateIndex
CREATE INDEX "access_devices_tenant_id_idx" ON "access_devices"("tenant_id");

-- CreateIndex
CREATE INDEX "access_devices_tenant_id_facility_id_idx" ON "access_devices"("tenant_id", "facility_id");

-- CreateIndex
CREATE INDEX "access_devices_tenant_id_is_online_idx" ON "access_devices"("tenant_id", "is_online");

-- CreateIndex
CREATE UNIQUE INDEX "access_devices_tenant_id_hardware_id_key" ON "access_devices"("tenant_id", "hardware_id");

-- CreateIndex
CREATE INDEX "access_logs_tenant_id_idx" ON "access_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "access_logs_tenant_id_occurred_at_idx" ON "access_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "access_logs_tenant_id_customer_id_occurred_at_idx" ON "access_logs"("tenant_id", "customer_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "access_logs_tenant_id_device_id_occurred_at_idx" ON "access_logs"("tenant_id", "device_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "access_logs_tenant_id_result_idx" ON "access_logs"("tenant_id", "result");

-- AddForeignKey
ALTER TABLE "access_credentials" ADD CONSTRAINT "access_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_credentials" ADD CONSTRAINT "access_credentials_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_credentials" ADD CONSTRAINT "access_credentials_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_devices" ADD CONSTRAINT "access_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_devices" ADD CONSTRAINT "access_devices_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_devices" ADD CONSTRAINT "access_devices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "access_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "access_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

