-- CreateEnum
CREATE TYPE "customer_type" AS ENUM ('individual', 'business');

-- CreateEnum
CREATE TYPE "customer_document_type" AS ENUM ('id_front', 'id_back', 'proof_of_address', 'other');

-- CreateEnum
CREATE TYPE "contract_status" AS ENUM ('draft', 'active', 'ending', 'ended', 'cancelled');

-- CreateEnum
CREATE TYPE "contract_billing_cycle" AS ENUM ('monthly', 'weekly', 'daily');

-- CreateEnum
CREATE TYPE "contract_deposit_status" AS ENUM ('none', 'held', 'returned', 'partially_returned');

-- CreateEnum
CREATE TYPE "contract_event_type" AS ENUM ('created', 'signed', 'price_changed', 'unit_changed', 'paused', 'resumed', 'ending_requested', 'ended', 'cancelled', 'note_added');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('pending', 'confirmed', 'expired', 'converted', 'cancelled');

-- NOTA: Prisma intento ALTER COLUMN sobre `units.area_m2` y `units.volume_m3`
-- (DROP DEFAULT). Esas columnas son GENERATED ALWAYS AS STORED desde Fase 2;
-- Prisma no las modela correctamente. Eliminado a mano.

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_type" "customer_type" NOT NULL DEFAULT 'individual',
    "first_name" TEXT,
    "last_name" TEXT,
    "company_name" TEXT,
    "document_type" TEXT,
    "document_number" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "postal_code" TEXT,
    "country" CHAR(2) NOT NULL DEFAULT 'ES',
    "emergency_contact_name" TEXT,
    "emergency_contact_phone" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "portal_access_enabled" BOOLEAN NOT NULL DEFAULT false,
    "portal_password_hash" TEXT,
    "kyc_verified" BOOLEAN NOT NULL DEFAULT false,
    "kyc_verified_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_documents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "customer_document_type" NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "uploaded_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "contract_number" TEXT NOT NULL,
    "status" "contract_status" NOT NULL DEFAULT 'draft',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "signed_at" TIMESTAMPTZ(6),
    "ending_requested_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "billing_cycle" "contract_billing_cycle" NOT NULL DEFAULT 'monthly',
    "price_monthly" DECIMAL(10,2) NOT NULL,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "deposit_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deposit_status" "contract_deposit_status" NOT NULL DEFAULT 'none',
    "signed_pdf_url" TEXT,
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "cancellation_notice_days" INTEGER NOT NULL DEFAULT 15,
    "notes" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "event_type" "contract_event_type" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "customer_id" UUID,
    "status" "reservation_status" NOT NULL DEFAULT 'pending',
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "deposit_paid" BOOLEAN NOT NULL DEFAULT false,
    "deposit_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "converted_contract_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_tenant_id_idx" ON "customers"("tenant_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_deleted_at_idx" ON "customers"("tenant_id", "deleted_at");

-- CreateIndex
CREATE INDEX "customers_tenant_id_document_number_idx" ON "customers"("tenant_id", "document_number");

-- CreateIndex
CREATE INDEX "customers_tenant_id_email_idx" ON "customers"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "customer_documents_tenant_id_idx" ON "customer_documents"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_documents_customer_id_idx" ON "customer_documents"("customer_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_idx" ON "contracts"("tenant_id");

-- CreateIndex
CREATE INDEX "contracts_tenant_id_status_idx" ON "contracts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "contracts_customer_id_idx" ON "contracts"("customer_id");

-- CreateIndex
CREATE INDEX "contracts_unit_id_idx" ON "contracts"("unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_tenant_id_contract_number_key" ON "contracts"("tenant_id", "contract_number");

-- CreateIndex
CREATE INDEX "contract_events_tenant_id_idx" ON "contract_events"("tenant_id");

-- CreateIndex
CREATE INDEX "contract_events_contract_id_occurred_at_idx" ON "contract_events"("contract_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "reservations_tenant_id_idx" ON "reservations"("tenant_id");

-- CreateIndex
CREATE INDEX "reservations_unit_id_status_idx" ON "reservations"("unit_id", "status");

-- CreateIndex
CREATE INDEX "reservations_customer_id_idx" ON "reservations"("customer_id");

-- CreateIndex
CREATE INDEX "reservations_valid_until_idx" ON "reservations"("valid_until");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
