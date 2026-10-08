-- Plan Administrador: liquidaciones al propietario (lo cobrado de sus
-- contratos menos honorarios y gastos de sus locales). Se guarda la foto de
-- cada liquidación enviada para tener el histórico tal y como se envió.
CREATE TABLE "owner_statements" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "collected" DECIMAL(12,2) NOT NULL,
  "refunded" DECIMAL(12,2) NOT NULL,
  "fee_base" DECIMAL(12,2) NOT NULL,
  "fee_vat" DECIMAL(12,2) NOT NULL,
  "expenses" DECIMAL(12,2) NOT NULL,
  "withholding" DECIMAL(12,2) NOT NULL,
  "net" DECIMAL(12,2) NOT NULL,
  "pending" DECIMAL(12,2) NOT NULL,
  "detail" JSONB NOT NULL,
  "sent_at" TIMESTAMPTZ(6),
  "sent_to" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "owner_statements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "owner_statements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "owner_statements_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "owner_statements_period_key" ON "owner_statements" ("owner_id", "period_start", "period_end");
CREATE INDEX "owner_statements_tenant_idx" ON "owner_statements" ("tenant_id", "owner_id");

ALTER TABLE "owner_statements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "owner_statements" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
