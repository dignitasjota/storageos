-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('new', 'contacted', 'qualified', 'won', 'lost');

-- CreateEnum
CREATE TYPE "lead_source" AS ENUM ('widget', 'referral', 'manual', 'import', 'phone', 'walkin', 'other');

-- CreateEnum
CREATE TYPE "communication_channel" AS ENUM ('email', 'sms', 'whatsapp');

-- CreateEnum
CREATE TYPE "communication_status" AS ENUM ('pending', 'processing', 'sent', 'delivered', 'bounced', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "communication_direction" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "message_template_kind" AS ENUM ('system', 'transactional', 'marketing');

-- CreateEnum
CREATE TYPE "automation_trigger" AS ENUM ('customer_created', 'contract_signed', 'contract_ending_soon', 'contract_ended', 'invoice_issued', 'invoice_overdue', 'invoice_paid', 'reservation_confirmed', 'lead_created');

-- CreateEnum
CREATE TYPE "automation_action_type" AS ENUM ('send_email', 'send_whatsapp', 'send_sms');

-- CreateEnum
CREATE TYPE "automation_run_status" AS ENUM ('pending', 'succeeded', 'skipped', 'failed');


-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "status" "lead_status" NOT NULL DEFAULT 'new',
    "source" "lead_source" NOT NULL DEFAULT 'manual',
    "first_name" TEXT,
    "last_name" TEXT,
    "company_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "message" TEXT,
    "preferred_facility_id" UUID,
    "preferred_unit_type_id" UUID,
    "preferred_start_date" DATE,
    "estimated_duration_months" INTEGER,
    "budget_monthly" DECIMAL(10,2),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "assigned_to_user_id" UUID,
    "contacted_at" TIMESTAMPTZ(6),
    "qualified_at" TIMESTAMPTZ(6),
    "won_at" TIMESTAMPTZ(6),
    "lost_at" TIMESTAMPTZ(6),
    "lost_reason" TEXT,
    "converted_customer_id" UUID,
    "converted_contract_id" UUID,
    "converted_reservation_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "message_template_kind" NOT NULL DEFAULT 'transactional',
    "channel" "communication_channel" NOT NULL DEFAULT 'email',
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'es-ES',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "channel" "communication_channel" NOT NULL DEFAULT 'email',
    "status" "communication_status" NOT NULL DEFAULT 'pending',
    "direction" "communication_direction" NOT NULL DEFAULT 'outbound',
    "template_id" UUID,
    "customer_id" UUID,
    "lead_id" UUID,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "provider_message_id" TEXT,
    "provider" TEXT,
    "source" TEXT,
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "scheduled_for" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "automation_trigger" NOT NULL,
    "action_type" "automation_action_type" NOT NULL,
    "template_id" UUID,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "trigger" "automation_trigger" NOT NULL,
    "status" "automation_run_status" NOT NULL DEFAULT 'pending',
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "communication_id" UUID,
    "event_payload" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_tenant_id_idx" ON "leads"("tenant_id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_status_idx" ON "leads"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "leads_tenant_id_assigned_to_user_id_idx" ON "leads"("tenant_id", "assigned_to_user_id");

-- CreateIndex
CREATE INDEX "message_templates_tenant_id_idx" ON "message_templates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_id_code_key" ON "message_templates"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "communications_tenant_id_idx" ON "communications"("tenant_id");

-- CreateIndex
CREATE INDEX "communications_tenant_id_status_scheduled_for_idx" ON "communications"("tenant_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "communications_tenant_id_customer_id_idx" ON "communications"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "communications_tenant_id_lead_id_idx" ON "communications"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "communications_provider_message_id_idx" ON "communications"("provider_message_id");

-- CreateIndex
CREATE INDEX "automation_rules_tenant_id_idx" ON "automation_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "automation_rules_tenant_id_trigger_is_active_idx" ON "automation_rules"("tenant_id", "trigger", "is_active");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_idx" ON "automation_runs"("tenant_id");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_rule_id_started_at_idx" ON "automation_runs"("tenant_id", "rule_id", "started_at");

-- CreateIndex
CREATE INDEX "automation_runs_entity_type_entity_id_idx" ON "automation_runs"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_preferred_facility_id_fkey" FOREIGN KEY ("preferred_facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_preferred_unit_type_id_fkey" FOREIGN KEY ("preferred_unit_type_id") REFERENCES "unit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_customer_id_fkey" FOREIGN KEY ("converted_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_contract_id_fkey" FOREIGN KEY ("converted_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_reservation_id_fkey" FOREIGN KEY ("converted_reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

