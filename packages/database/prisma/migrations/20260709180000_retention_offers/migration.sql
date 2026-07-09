-- Motor de retención: el staff hace una contraoferta (descuento en la cuota) a un
-- inquilino que ha solicitado la baja; si la acepta desde el portal, se revierte
-- la baja y se aplica el descuento a su contrato.
CREATE TABLE "retention_offers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "discount_type" TEXT NOT NULL,
    "discount_value" DECIMAL(10, 2) NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "valid_until" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "responded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "retention_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retention_offers_tenant_status_idx" ON "retention_offers" ("tenant_id", "status");
CREATE INDEX "retention_offers_contract_idx" ON "retention_offers" ("tenant_id", "contract_id");
CREATE INDEX "retention_offers_customer_idx" ON "retention_offers" ("tenant_id", "customer_id");

ALTER TABLE "retention_offers" ADD CONSTRAINT "retention_offers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retention_offers" ADD CONSTRAINT "retention_offers_contract_id_fkey"
    FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retention_offers" ADD CONSTRAINT "retention_offers_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retention_offers" ADD CONSTRAINT "retention_offers_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "retention_offers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "retention_offers";
CREATE POLICY tenant_isolation ON "retention_offers" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
