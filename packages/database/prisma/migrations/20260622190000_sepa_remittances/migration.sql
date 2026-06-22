-- Pagos España: remesas SEPA (adeudos directos / fichero bancario pain.008).
--
-- El operador cobra las facturas domiciliadas generando un XML SEPA (CORE) que
-- sube a su banco — sin comisiones de pasarela. Requiere: config del acreedor
-- (Identificador del acreedor + IBAN), mandatos por cliente (IBAN del deudor +
-- referencia + fecha de firma + secuencia FRST/RCUR), y la remesa (lote).

-- Config del acreedor por tenant (IBAN cifrado AES-GCM, como redsys/holded).
CREATE TABLE "sepa_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "creditor_name" TEXT NOT NULL,
  -- Identificador del acreedor SEPA (p.ej. ES12ZZZ + NIF).
  "creditor_id" TEXT NOT NULL,
  "creditor_iban_encrypted" TEXT NOT NULL,
  "creditor_bic" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sepa_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sepa_settings_tenant_id_key" UNIQUE ("tenant_id")
);
ALTER TABLE "sepa_settings"
  ADD CONSTRAINT "sepa_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mandato SEPA por cliente (IBAN del deudor cifrado).
CREATE TABLE "sepa_mandates" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "iban_encrypted" TEXT NOT NULL,
  "iban_last4" TEXT NOT NULL,
  "bic" TEXT,
  "signed_at" DATE NOT NULL,
  -- FRST hasta el primer cobro con éxito; luego RCUR.
  "sequence_type" TEXT NOT NULL DEFAULT 'FRST',
  -- active | cancelled
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sepa_mandates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sepa_mandates_tenant_id_reference_key" UNIQUE ("tenant_id", "reference")
);
CREATE INDEX "sepa_mandates_tenant_id_customer_id_idx" ON "sepa_mandates"("tenant_id", "customer_id");
-- Un único mandato activo por cliente (índice parcial).
CREATE UNIQUE INDEX "sepa_mandates_active_per_customer_key"
  ON "sepa_mandates"("customer_id") WHERE "status" = 'active';
ALTER TABLE "sepa_mandates"
  ADD CONSTRAINT "sepa_mandates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sepa_mandates"
  ADD CONSTRAINT "sepa_mandates_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remesa (lote de adeudos para una fecha de cobro).
CREATE TABLE "sepa_remittances" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "collection_date" DATE NOT NULL,
  -- generated | confirmed | cancelled
  "status" TEXT NOT NULL DEFAULT 'generated',
  "item_count" INTEGER NOT NULL DEFAULT 0,
  "total_amount" INTEGER NOT NULL DEFAULT 0,
  "xml" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "confirmed_at" TIMESTAMPTZ(6),
  CONSTRAINT "sepa_remittances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sepa_remittances_tenant_id_status_idx" ON "sepa_remittances"("tenant_id", "status");
ALTER TABLE "sepa_remittances"
  ADD CONSTRAINT "sepa_remittances_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Línea de remesa (una por factura).
CREATE TABLE "sepa_remittance_items" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "remittance_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "mandate_id" UUID NOT NULL,
  "amount" INTEGER NOT NULL,
  "sequence_type" TEXT NOT NULL,
  "end_to_end_id" TEXT NOT NULL,
  CONSTRAINT "sepa_remittance_items_pkey" PRIMARY KEY ("id"),
  -- Una factura solo puede estar en una remesa no cancelada a la vez.
  CONSTRAINT "sepa_remittance_items_invoice_id_key" UNIQUE ("invoice_id")
);
CREATE INDEX "sepa_remittance_items_tenant_id_idx" ON "sepa_remittance_items"("tenant_id");
ALTER TABLE "sepa_remittance_items"
  ADD CONSTRAINT "sepa_remittance_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sepa_remittance_items"
  ADD CONSTRAINT "sepa_remittance_items_remittance_id_fkey"
  FOREIGN KEY ("remittance_id") REFERENCES "sepa_remittances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sepa_remittance_items"
  ADD CONSTRAINT "sepa_remittance_items_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sepa_remittance_items"
  ADD CONSTRAINT "sepa_remittance_items_mandate_id_fkey"
  FOREIGN KEY ("mandate_id") REFERENCES "sepa_mandates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS en las 4 tablas.
ALTER TABLE "sepa_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sepa_settings";
CREATE POLICY tenant_isolation ON "sepa_settings" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "sepa_mandates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sepa_mandates";
CREATE POLICY tenant_isolation ON "sepa_mandates" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "sepa_remittances" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sepa_remittances";
CREATE POLICY tenant_isolation ON "sepa_remittances" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "sepa_remittance_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sepa_remittance_items";
CREATE POLICY tenant_isolation ON "sepa_remittance_items" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
