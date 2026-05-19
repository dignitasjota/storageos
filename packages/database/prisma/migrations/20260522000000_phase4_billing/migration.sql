
-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'paid', 'overdue', 'cancelled', 'refunded', 'partially_refunded');

-- CreateEnum
CREATE TYPE "verifactu_mode" AS ENUM ('verifactu', 'no_verifactu');

-- CreateEnum
CREATE TYPE "aeat_status" AS ENUM ('pending', 'accepted', 'accepted_with_warnings', 'rejected', 'error');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'refunded', 'partially_refunded');

-- CreateEnum
CREATE TYPE "payment_method_type" AS ENUM ('card', 'sepa_debit', 'bank_transfer', 'cash', 'other');

-- CreateEnum
CREATE TYPE "payment_gateway_provider" AS ENUM ('stripe', 'gocardless', 'redsys', 'manual');

-- CreateEnum
CREATE TYPE "dunning_action_type" AS ENUM ('email_reminder', 'sms_reminder', 'late_fee', 'access_block', 'legal_notice');

-- CreateEnum
CREATE TYPE "dunning_action_status" AS ENUM ('scheduled', 'executed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "pricing_rule_scope" AS ENUM ('unit', 'unit_type', 'facility', 'tenant');

-- CreateEnum
CREATE TYPE "pricing_rule_type" AS ENUM ('seasonal', 'occupancy_based', 'duration_discount', 'custom');

-- CreateEnum
CREATE TYPE "price_modifier_type" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "promotion_discount_type" AS ENUM ('percentage', 'fixed', 'free_months');

-- CreateEnum
CREATE TYPE "data_subject_request_type" AS ENUM ('access', 'rectification', 'erasure', 'portability', 'restriction');

-- CreateEnum
CREATE TYPE "data_subject_request_status" AS ENUM ('open', 'in_progress', 'fulfilled', 'denied');

-- NOTA: Prisma intento operaciones sobre columnas/indices GENERATED o
-- gist que NO modela (`reservations.time_range`, indice gist del mismo,
-- `units.area_m2/volume_m3`). Eliminado a mano para que sigan vivos.

-- CreateTable
CREATE TABLE "invoice_series" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "year_scope" BOOLEAN NOT NULL DEFAULT true,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "facility_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contract_id" UUID,
    "series_id" UUID NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "issue_date" DATE,
    "due_date" DATE,
    "period_start" DATE,
    "period_end" DATE,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_refunded" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "pdf_url" TEXT,
    "notes" TEXT,
    "hash" TEXT,
    "previous_hash" TEXT,
    "qr_code_url" TEXT,
    "verifactu_mode" "verifactu_mode" NOT NULL DEFAULT 'verifactu',
    "aeat_sent_at" TIMESTAMPTZ(6),
    "aeat_status" "aeat_status",
    "aeat_response" JSONB,
    "aeat_csv" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 21,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "related_contract_id" UUID,
    "related_unit_id" UUID,
    "period_start" DATE,
    "period_end" DATE,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID,
    "customer_id" UUID NOT NULL,
    "payment_method_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "method_type" "payment_method_type" NOT NULL,
    "gateway" "payment_gateway_provider" NOT NULL DEFAULT 'manual',
    "gateway_payment_id" TEXT,
    "gateway_response" JSONB,
    "paid_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "refunded_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "payment_method_type" NOT NULL,
    "gateway" "payment_gateway_provider" NOT NULL,
    "gateway_token_encrypted" TEXT NOT NULL,
    "gateway_customer_id" TEXT,
    "last4" CHAR(4),
    "brand" TEXT,
    "exp_month" INTEGER,
    "exp_year" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "mandate_reference" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dunning_actions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "action_type" "dunning_action_type" NOT NULL,
    "status" "dunning_action_status" NOT NULL DEFAULT 'scheduled',
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "executed_at" TIMESTAMPTZ(6),
    "result" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dunning_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "pricing_rule_scope" NOT NULL,
    "target_id" UUID,
    "rule_type" "pricing_rule_type" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "modifier_type" "price_modifier_type" NOT NULL,
    "modifier_value" DECIMAL(10,2) NOT NULL,
    "valid_from" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discount_type" "promotion_discount_type" NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "applies_to" JSONB NOT NULL DEFAULT '{}',
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_subject_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID,
    "email" TEXT NOT NULL,
    "request_type" "data_subject_request_type" NOT NULL,
    "status" "data_subject_request_status" NOT NULL DEFAULT 'open',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "fulfilled_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "handled_by_user_id" UUID,
    "export_file_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "granted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_series_tenant_id_idx" ON "invoice_series"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_tenant_id_code_key" ON "invoice_series"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_idx" ON "invoices"("tenant_id");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_status_idx" ON "invoices"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "invoices_customer_id_idx" ON "invoices"("customer_id");

-- CreateIndex
CREATE INDEX "invoices_due_date_idx" ON "invoices"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_series_id_sequence_number_key" ON "invoices"("tenant_id", "series_id", "sequence_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_invoice_number_key" ON "invoices"("tenant_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_items_tenant_id_idx" ON "invoice_items"("tenant_id");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_idx" ON "payments"("tenant_id");

-- CreateIndex
CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_customer_id_idx" ON "payments"("customer_id");

-- CreateIndex
CREATE INDEX "payments_gateway_payment_id_idx" ON "payments"("gateway_payment_id");

-- CreateIndex
CREATE INDEX "payment_methods_tenant_id_idx" ON "payment_methods"("tenant_id");

-- CreateIndex
CREATE INDEX "payment_methods_customer_id_deleted_at_idx" ON "payment_methods"("customer_id", "deleted_at");

-- CreateIndex
CREATE INDEX "dunning_actions_tenant_id_idx" ON "dunning_actions"("tenant_id");

-- CreateIndex
CREATE INDEX "dunning_actions_invoice_id_idx" ON "dunning_actions"("invoice_id");

-- CreateIndex
CREATE INDEX "dunning_actions_scheduled_for_status_idx" ON "dunning_actions"("scheduled_for", "status");

-- CreateIndex
CREATE INDEX "pricing_rules_tenant_id_idx" ON "pricing_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "pricing_rules_tenant_id_is_active_scope_idx" ON "pricing_rules"("tenant_id", "is_active", "scope");

-- CreateIndex
CREATE INDEX "promotions_tenant_id_is_active_idx" ON "promotions"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_tenant_id_code_key" ON "promotions"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "data_subject_requests_tenant_id_idx" ON "data_subject_requests"("tenant_id");

-- CreateIndex
CREATE INDEX "data_subject_requests_status_due_at_idx" ON "data_subject_requests"("status", "due_at");

-- CreateIndex
CREATE INDEX "consents_tenant_id_idx" ON "consents"("tenant_id");

-- CreateIndex
CREATE INDEX "consents_customer_id_purpose_idx" ON "consents"("customer_id", "purpose");

-- AddForeignKey
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "invoice_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_related_contract_id_fkey" FOREIGN KEY ("related_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dunning_actions" ADD CONSTRAINT "dunning_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dunning_actions" ADD CONSTRAINT "dunning_actions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_handled_by_user_id_fkey" FOREIGN KEY ("handled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

