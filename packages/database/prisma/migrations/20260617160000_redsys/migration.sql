-- Plan 4 (Redsys): TPV bancario por pasarela alojada.

CREATE TABLE "redsys_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "merchant_code" TEXT NOT NULL,
  "terminal" TEXT NOT NULL DEFAULT '1',
  "secret_key_encrypted" TEXT NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'test',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redsys_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "redsys_settings_tenant_id_key" ON "redsys_settings"("tenant_id");
ALTER TABLE "redsys_settings"
  ADD CONSTRAINT "redsys_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "redsys_orders" (
  "order" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "ds_response" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "paid_at" TIMESTAMPTZ(6),
  CONSTRAINT "redsys_orders_pkey" PRIMARY KEY ("order")
);
CREATE INDEX "redsys_orders_tenant_id_idx" ON "redsys_orders"("tenant_id");
CREATE INDEX "redsys_orders_invoice_id_idx" ON "redsys_orders"("invoice_id");
ALTER TABLE "redsys_orders"
  ADD CONSTRAINT "redsys_orders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "redsys_orders"
  ADD CONSTRAINT "redsys_orders_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS
ALTER TABLE "redsys_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "redsys_settings";
CREATE POLICY tenant_isolation ON "redsys_settings"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "redsys_orders" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "redsys_orders";
CREATE POLICY tenant_isolation ON "redsys_orders"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
