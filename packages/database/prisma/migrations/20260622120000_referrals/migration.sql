-- Crecimiento/CRM: programa de referidos.
--
-- Cada cliente tiene un `referral_code` único que comparte. Cuando un nuevo
-- cliente se da de alta con ese código y su primer contrato se firma, el
-- referidor recibe una recompensa (promoción de un solo uso). Opt-in por tenant.

-- Código de referido por cliente (único por tenant, autogenerado).
ALTER TABLE "customers" ADD COLUMN "referral_code" TEXT;
CREATE UNIQUE INDEX "customers_tenant_id_referral_code_key"
  ON "customers"("tenant_id", "referral_code")
  WHERE "referral_code" IS NOT NULL;

-- Config del programa por tenant (opt-in).
ALTER TABLE "tenants" ADD COLUMN "referral_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "referral_reward_type" "promotion_discount_type" NOT NULL DEFAULT 'fixed';
ALTER TABLE "tenants" ADD COLUMN "referral_reward_value" DECIMAL(10, 2) NOT NULL DEFAULT 0;

-- Referidos: referidor ↔ referido.
CREATE TABLE "referrals" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "referrer_customer_id" UUID NOT NULL,
  "referred_customer_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reward_promotion_id" UUID,
  "converted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- Un cliente solo puede ser referido una vez.
CREATE UNIQUE INDEX "referrals_referred_customer_id_key"
  ON "referrals"("referred_customer_id");
CREATE INDEX "referrals_tenant_id_status_idx" ON "referrals"("tenant_id", "status");
CREATE INDEX "referrals_referrer_customer_id_idx" ON "referrals"("referrer_customer_id");

ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_referrer_customer_id_fkey"
  FOREIGN KEY ("referrer_customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_referred_customer_id_fkey"
  FOREIGN KEY ("referred_customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_reward_promotion_id_fkey"
  FOREIGN KEY ("reward_promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "referrals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "referrals";
CREATE POLICY tenant_isolation ON "referrals"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
