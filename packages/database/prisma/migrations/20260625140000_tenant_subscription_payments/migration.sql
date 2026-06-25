-- Historial de pagos de la suscripción SaaS del tenant (lo que la empresa paga
-- por la plataforma). Desacoplado del gateway: hoy Stripe, mañana transferencia,
-- otro proveedor o un pago manual — todos se registran aquí con su `provider`.
CREATE TABLE "tenant_subscription_payments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "plan_slug" TEXT,
    "plan_name" TEXT,
    "description" TEXT,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "invoice_url" TEXT,
    "pdf_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tenant_subscription_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_subscription_payments_tenant_id_idx"
    ON "tenant_subscription_payments" ("tenant_id", "paid_at");

-- Idempotencia: un mismo pago externo (p. ej. una invoice de Stripe) no se
-- duplica (el sync/webhook hace upsert por (provider, external_id)).
CREATE UNIQUE INDEX "tenant_subscription_payments_external_uniq"
    ON "tenant_subscription_payments" ("provider", "external_id")
    WHERE "external_id" IS NOT NULL;

ALTER TABLE "tenant_subscription_payments"
    ADD CONSTRAINT "tenant_subscription_payments_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_subscription_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_subscription_payments";
CREATE POLICY tenant_isolation ON "tenant_subscription_payments" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
