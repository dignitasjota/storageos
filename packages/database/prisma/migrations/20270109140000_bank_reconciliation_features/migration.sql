-- Conciliación bancaria (revisión de Cobros, PR B): el abono de una remesa SEPA
-- de una vez, cargos que son gastos, reglas aprendidas y el CSV de la banca.

-- De dónde salió el extracto: n43 | csv.
ALTER TABLE bank_statements ADD COLUMN source TEXT NOT NULL DEFAULT 'n43';

ALTER TABLE bank_statement_transactions
  -- El abono de una remesa SEPA, conciliado de una vez.
  ADD COLUMN matched_remittance_id UUID REFERENCES sepa_remittances(id) ON DELETE SET NULL,
  -- El gasto en que se convirtió un cargo.
  ADD COLUMN expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL;

-- Reglas aprendidas: si el concepto lleva el patrón, es de este inquilino
-- (customer) o es un gasto de esta categoría (expense).
CREATE TABLE bank_match_rules (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pattern            TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'customer',
  customer_id        UUID REFERENCES customers(id) ON DELETE CASCADE,
  expense_category   TEXT,
  hits               INTEGER NOT NULL DEFAULT 0,
  last_used_at       TIMESTAMPTZ(6),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX bank_match_rules_tenant_kind_pattern ON bank_match_rules (tenant_id, kind, pattern);

ALTER TABLE bank_match_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_match_rules FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_match_rules TO storageos_app;
