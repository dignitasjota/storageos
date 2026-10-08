-- Plan «Administrador»: varios propietarios por cuenta. Cada local pertenece a
-- un propietario (sin propietario = el propio tenant). El contrato guarda el
-- propietario al crearse: sus facturas no cambian si luego se reasigna el local.
CREATE TABLE "owners" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "legal_name" TEXT NOT NULL,
  "tax_id" TEXT NOT NULL,
  "address" TEXT,
  "city" TEXT,
  "postal_code" TEXT,
  "email" TEXT,
  "phone" TEXT,
  -- Cuenta del propietario (a donde se le transfiere la liquidación).
  "iban_encrypted" TEXT,
  "iban_last4" TEXT,
  -- Honorarios del administrador: % de lo cobrado o cuota fija mensual.
  "fee_type" TEXT NOT NULL DEFAULT 'percentage',
  "fee_value" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "owners_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "owners_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "owners_tenant_id_tax_id_key" ON "owners" ("tenant_id", "tax_id");
CREATE INDEX "owners_tenant_id_idx" ON "owners" ("tenant_id");

ALTER TABLE "owners" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "owners" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "facilities" ADD COLUMN "owner_id" UUID REFERENCES "owners"("id") ON DELETE SET NULL;
ALTER TABLE "contracts" ADD COLUMN "owner_id" UUID REFERENCES "owners"("id") ON DELETE SET NULL;
CREATE INDEX "contracts_owner_id_idx" ON "contracts" ("owner_id") WHERE "owner_id" IS NOT NULL;
