-- Stripe Connect: cada tenant conecta su propia cuenta de Stripe (Express) para
-- cobrar a sus inquilinos con tarjeta; el dinero va a su cuenta y la plataforma
-- cobra una comisión por cobro (configurable desde el panel admin).

-- Ajustes de cobros de la plataforma (un registro). Global → REVOKE.
CREATE TABLE "platform_payment_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- Comisión de la plataforma sobre cada cobro de Stripe de un tenant (%).
  "application_fee_pct" DECIMAL(5,2) NOT NULL DEFAULT 2,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_payment_settings_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_payment_settings" FROM storageos_app;

-- Cuenta conectada de Stripe del tenant (una por tenant).
CREATE TABLE "tenant_stripe_accounts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "stripe_account_id" TEXT NOT NULL,
  "charges_enabled" BOOLEAN NOT NULL DEFAULT false,
  "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
  "details_submitted" BOOLEAN NOT NULL DEFAULT false,
  -- Datos que Stripe aún pide (requirements.currently_due).
  "requirements_due" TEXT[] NOT NULL DEFAULT '{}',
  "disabled_reason" TEXT,
  "last_synced_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_stripe_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_stripe_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "tenant_stripe_accounts_tenant_key" ON "tenant_stripe_accounts" ("tenant_id");
CREATE UNIQUE INDEX "tenant_stripe_accounts_account_key" ON "tenant_stripe_accounts" ("stripe_account_id");

ALTER TABLE "tenant_stripe_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_stripe_accounts" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- Con qué se cobra la tarjeta a los inquilinos: redsys | stripe. null = Redsys
-- si está activo (comportamiento de siempre).
ALTER TABLE "tenants" ADD COLUMN "card_provider" TEXT;
