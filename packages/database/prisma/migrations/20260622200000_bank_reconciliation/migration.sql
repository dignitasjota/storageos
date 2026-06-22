-- Conciliación bancaria (Norma 43 / Cuaderno 43 AEB).
--
-- El operador sube el fichero N43 de su banco; se parsea en un extracto
-- (bank_statements) con sus movimientos (bank_statement_transactions). Los
-- abonos se concilian contra las facturas pendientes (sobre todo las de las
-- remesas SEPA) y se marcan pagadas.

CREATE TABLE "bank_statements" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "filename" TEXT NOT NULL,
  -- Cuenta: entidad+oficina+nº (formateado para mostrar).
  "account_label" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "start_date" DATE,
  "end_date" DATE,
  "initial_balance" INTEGER NOT NULL DEFAULT 0,
  "final_balance" INTEGER NOT NULL DEFAULT 0,
  "transaction_count" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_statements_tenant_id_idx" ON "bank_statements"("tenant_id");
ALTER TABLE "bank_statements"
  ADD CONSTRAINT "bank_statements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "bank_statement_transactions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "statement_id" UUID NOT NULL,
  "operation_date" DATE,
  "value_date" DATE,
  -- importe en céntimos con signo: + abono (haber), − cargo (debe).
  "amount" INTEGER NOT NULL,
  "concept_common" TEXT,
  "concept_own" TEXT,
  "reference1" TEXT,
  "reference2" TEXT,
  "document_number" TEXT,
  "description" TEXT,
  -- pending | matched | ignored
  "status" TEXT NOT NULL DEFAULT 'pending',
  "matched_invoice_id" UUID,
  "matched_at" TIMESTAMPTZ(6),
  CONSTRAINT "bank_statement_transactions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_statement_transactions_tenant_id_idx" ON "bank_statement_transactions"("tenant_id");
CREATE INDEX "bank_statement_transactions_statement_id_idx" ON "bank_statement_transactions"("statement_id");
ALTER TABLE "bank_statement_transactions"
  ADD CONSTRAINT "bank_statement_transactions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_statement_transactions"
  ADD CONSTRAINT "bank_statement_transactions_statement_id_fkey"
  FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_statement_transactions"
  ADD CONSTRAINT "bank_statement_transactions_matched_invoice_id_fkey"
  FOREIGN KEY ("matched_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "bank_statements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "bank_statements";
CREATE POLICY tenant_isolation ON "bank_statements" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "bank_statement_transactions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "bank_statement_transactions";
CREATE POLICY tenant_isolation ON "bank_statement_transactions" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
