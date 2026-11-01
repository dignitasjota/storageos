-- Catálogo y precios del panel admin: mejoras.

-- Planes ocultos: no salen en la web ni en el autoservicio, pero el super
-- admin puede asignarlos (planes negociados).
ALTER TABLE "subscription_plans" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT true;

-- Precio por tramos de cantidad de un extra: [{ "minQuantity": 1, "unitPrice": 5 }, …].
ALTER TABLE "subscription_addons" ADD COLUMN "price_tiers" JSONB;

-- Histórico de precios de planes y extras.
CREATE TABLE "catalog_price_history" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "kind" TEXT NOT NULL,
  "item_id" UUID NOT NULL,
  "item_name" TEXT NOT NULL,
  "old_price_monthly" DECIMAL(12,2),
  "new_price_monthly" DECIMAL(12,2),
  "old_price_yearly" DECIMAL(12,2),
  "new_price_yearly" DECIMAL(12,2),
  "super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "catalog_price_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "catalog_price_history_item_idx" ON "catalog_price_history" ("kind", "item_id", "created_at");
REVOKE ALL ON "catalog_price_history" FROM storageos_app;

-- Cupones de plataforma: condiciones y espejo en Stripe.
ALTER TABLE "platform_coupons"
  ADD COLUMN "stripe_coupon_id" TEXT,
  ADD COLUMN "plan_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "duration_months" INTEGER,
  ADD COLUMN "once_per_tenant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "valid_from" TIMESTAMPTZ(6);

-- Cada uso de un cupón de plataforma.
CREATE TABLE "platform_coupon_redemptions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "coupon_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "payment_id" UUID,
  "discount" DECIMAL(12,2),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_coupon_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_coupon_redemptions_coupon_fkey" FOREIGN KEY ("coupon_id") REFERENCES "platform_coupons"("id") ON DELETE CASCADE,
  CONSTRAINT "platform_coupon_redemptions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "platform_coupon_redemptions_coupon_idx" ON "platform_coupon_redemptions" ("coupon_id", "created_at");
CREATE INDEX "platform_coupon_redemptions_tenant_idx" ON "platform_coupon_redemptions" ("tenant_id", "coupon_id");
REVOKE ALL ON "platform_coupon_redemptions" FROM storageos_app;

-- Propuestas de cuota enviadas desde el simulador.
CREATE TABLE "platform_quote_offers" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "super_admin_id" UUID,
  "plan_id" UUID NOT NULL,
  "cycle" TEXT NOT NULL,
  "addons" JSONB NOT NULL DEFAULT '[]',
  "coupon_code" TEXT,
  "total" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sent',
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_quote_offers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_quote_offers_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "platform_quote_offers_plan_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE CASCADE
);
CREATE INDEX "platform_quote_offers_tenant_idx" ON "platform_quote_offers" ("tenant_id", "status");
CREATE INDEX "platform_quote_offers_created_idx" ON "platform_quote_offers" ("created_at");
REVOKE ALL ON "platform_quote_offers" FROM storageos_app;

-- Comisión por cobros con tarjeta propia de un tenant (null = la general).
ALTER TABLE "tenants" ADD COLUMN "application_fee_pct" DECIMAL(5,2);
