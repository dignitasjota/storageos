-- Cobro de la suscripción SaaS por SEPA directo (Fase 2): remesa pain.008 +
-- confirmación de cobro. Sin RLS (tablas de plataforma, como
-- platform_sepa_settings/platform_sepa_mandates de la Fase 1).

CREATE TABLE "platform_sepa_remittances" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "collection_date" DATE NOT NULL,
    -- generated | confirmed | cancelled
    "status" TEXT NOT NULL DEFAULT 'generated',
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "total_amount" INTEGER NOT NULL DEFAULT 0,
    "xml" TEXT,
    "created_by_super_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "confirmed_at" TIMESTAMPTZ(6),
    CONSTRAINT "platform_sepa_remittances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_sepa_remittances_status_idx" ON "platform_sepa_remittances" ("status");

-- Línea de remesa: una por tenant+periodo cubierto. La unicidad
-- (tenant_id, period_covered) es la clave anti-doble-cobro.
CREATE TABLE "platform_sepa_remittance_items" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "remittance_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mandate_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "sequence_type" TEXT NOT NULL,
    "end_to_end_id" TEXT NOT NULL,
    "period_covered" DATE NOT NULL,
    -- pending | collected | bounced
    "item_status" TEXT NOT NULL DEFAULT 'pending',
    "bounced_at" TIMESTAMPTZ(6),
    "bounce_reason" TEXT,
    CONSTRAINT "platform_sepa_remittance_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_sepa_remittance_items_tenant_period_key" UNIQUE ("tenant_id", "period_covered")
);
CREATE INDEX "platform_sepa_remittance_items_remittance_id_idx" ON "platform_sepa_remittance_items" ("remittance_id");
CREATE INDEX "platform_sepa_remittance_items_tenant_id_idx" ON "platform_sepa_remittance_items" ("tenant_id");
ALTER TABLE "platform_sepa_remittance_items" ADD CONSTRAINT "platform_sepa_remittance_items_remittance_id_fkey"
    FOREIGN KEY ("remittance_id") REFERENCES "platform_sepa_remittances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_sepa_remittance_items" ADD CONSTRAINT "platform_sepa_remittance_items_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_sepa_remittance_items" ADD CONSTRAINT "platform_sepa_remittance_items_mandate_id_fkey"
    FOREIGN KEY ("mandate_id") REFERENCES "platform_sepa_mandates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
