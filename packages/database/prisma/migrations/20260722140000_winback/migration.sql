-- Win-back automático de bajas: N días después de que un inquilino se va (sin
-- contrato activo), se le envía una oferta de vuelta por email. Opt-in por tenant.
ALTER TABLE "tenants"
  ADD COLUMN "winback_enabled"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "winback_delay_days" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN "winback_subject"    TEXT,
  ADD COLUMN "winback_body_text"  TEXT;

-- Registro de envíos (idempotencia: un solo win-back por ex-cliente).
CREATE TABLE "winback_sends" (
    "id"          UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id"   UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "sent_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "winback_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "winback_sends_tenant_customer_key"
    ON "winback_sends" ("tenant_id", "customer_id");

ALTER TABLE "winback_sends" ADD CONSTRAINT "winback_sends_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "winback_sends" ADD CONSTRAINT "winback_sends_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "winback_sends" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "winback_sends";
CREATE POLICY tenant_isolation ON "winback_sends" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
