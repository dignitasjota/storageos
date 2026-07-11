-- Cobro automático de add-ons por Stripe (v2, por add-on).
-- v1 dejó los add-ons DESACOPLADOS de Stripe (cobro manual vía la bandeja «Hoy»).
-- Ahora cada add-on del catálogo puede mapearse a un Price recurrente de Stripe,
-- y cada add-on contratado por un tenant lleva un modo de cobro:
--   'manual' (por defecto, bandeja «Hoy») | 'stripe' (subscription item de su suscripción).

-- Catálogo: mapeo del add-on a su Product/Price recurrente de Stripe (se crea al
-- pasar un add-on a modo Stripe la primera vez; null = aún sin Price).
ALTER TABLE "subscription_addons"
  ADD COLUMN "stripe_price_id" TEXT,
  ADD COLUMN "stripe_product_id" TEXT;

-- Add-on contratado: modo de cobro + id del subscription item de Stripe (si modo stripe).
ALTER TABLE "tenant_subscription_addons"
  ADD COLUMN "billing_mode" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "stripe_subscription_item_id" TEXT;

-- Desglose por líneas de la factura de plataforma (plan + add-ons). La factura
-- sigue teniendo su cabecera monolínea (base/IVA/total) por compatibilidad; estas
-- líneas son el detalle informativo que se muestra en el PDF y en el panel.
CREATE TABLE "platform_invoice_lines" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "platform_invoice_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'plan',
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_amount" DECIMAL(12,2) NOT NULL,
    "base_amount" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "tax_amount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_invoice_lines_invoice_idx" ON "platform_invoice_lines" ("platform_invoice_id");
ALTER TABLE "platform_invoice_lines" ADD CONSTRAINT "platform_invoice_lines_invoice_id_fkey"
    FOREIGN KEY ("platform_invoice_id") REFERENCES "platform_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
