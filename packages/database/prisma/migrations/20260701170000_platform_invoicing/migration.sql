-- Facturación del SaaS: StorageOS emite facturas de suscripción a sus tenants.
-- Tablas GLOBALES (sin tenant_id/RLS; solo el super admin las gestiona vía
-- PrismaAdminService), como el resto de datos de administración.

-- Datos fiscales del emisor (StorageOS). Singleton (una sola fila).
CREATE TABLE "platform_billing_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "legal_name" TEXT NOT NULL DEFAULT '',
    "tax_id" TEXT NOT NULL DEFAULT '',
    "address" TEXT,
    "city" TEXT,
    "postal_code" TEXT,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "email" TEXT,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 21,
    "series_prefix" TEXT NOT NULL DEFAULT 'SAAS',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_billing_settings_pkey" PRIMARY KEY ("id")
);

-- Facturas emitidas al tenant por la suscripción.
CREATE TABLE "platform_invoices" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "series" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "full_number" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tenant_name" TEXT NOT NULL,
    "tenant_tax_id" TEXT,
    "tenant_email" TEXT,
    "tenant_address" TEXT,
    "plan_slug" TEXT,
    "plan_name" TEXT,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "base_amount" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "tax_amount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "pdf_url" TEXT,
    "payment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_invoices_series_number_key" ON "platform_invoices" ("series", "number");
CREATE UNIQUE INDEX "platform_invoices_payment_id_key" ON "platform_invoices" ("payment_id") WHERE "payment_id" IS NOT NULL;
CREATE INDEX "platform_invoices_tenant_idx" ON "platform_invoices" ("tenant_id", "issued_at" DESC);
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "tenant_subscription_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
