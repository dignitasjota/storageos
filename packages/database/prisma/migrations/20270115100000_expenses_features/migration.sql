-- Gastos: proveedores, desglose fiscal, justificante, estado de pago,
-- recurrentes trimestrales y anuales, categorías propias y presupuesto
-- (2026-11-13).

-- Proveedores, con los valores que rellenan el gasto al elegirlos.
CREATE TABLE expense_suppliers (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  tax_id                    TEXT,
  email                     TEXT,
  phone                     TEXT,
  default_category          TEXT,
  default_vat_rate          NUMERIC(5, 2),
  default_withholding_rate  NUMERIC(5, 2),
  -- 111 (profesionales) · 115 (alquiler del local)
  default_withholding_model TEXT,
  default_payment_method    TEXT,
  notes                     TEXT,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expense_suppliers_tenant_tax_id_key
  ON expense_suppliers (tenant_id, upper(tax_id)) WHERE tax_id IS NOT NULL;
CREATE INDEX expense_suppliers_tenant_name_idx ON expense_suppliers (tenant_id, name);

ALTER TABLE expense_suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_suppliers FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_suppliers TO storageos_app;

-- Categorías propias de cada empresa (en el gasto: «custom:<id>»).
CREATE TABLE expense_categories (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expense_categories_tenant_name_key
  ON expense_categories (tenant_id, lower(name));

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_categories FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_categories TO storageos_app;

-- Presupuesto mensual por categoría.
CREATE TABLE expense_budgets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  monthly_amount NUMERIC(12, 2) NOT NULL CHECK (monthly_amount >= 0),
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expense_budgets_tenant_category_key ON expense_budgets (tenant_id, category);

ALTER TABLE expense_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_budgets FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_budgets TO storageos_app;

-- Gasto: proveedor y su factura, desglose fiscal, justificante y pago.
-- `amount` sigue siendo lo que cuesta (base + el IVA que no se deduce); el
-- desglose es opcional: sin él, el gasto queda «sin desglosar».
ALTER TABLE expenses
  ADD COLUMN supplier_id        UUID REFERENCES expense_suppliers(id) ON DELETE SET NULL,
  ADD COLUMN vendor_tax_id      TEXT,
  ADD COLUMN invoice_number     TEXT,
  ADD COLUMN base_amount        NUMERIC(12, 2),
  ADD COLUMN vat_rate           NUMERIC(5, 2),
  ADD COLUMN vat_amount         NUMERIC(12, 2),
  ADD COLUMN vat_deductible     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN withholding_rate   NUMERIC(5, 2),
  ADD COLUMN withholding_amount NUMERIC(12, 2),
  ADD COLUMN withholding_model  TEXT,
  -- Lo que se paga al proveedor (base + IVA − retención).
  ADD COLUMN total_amount       NUMERIC(12, 2),
  ADD COLUMN receipt_key        TEXT,
  ADD COLUMN receipt_name       TEXT,
  ADD COLUMN receipt_mime       TEXT,
  -- paid · pending
  ADD COLUMN payment_status     TEXT NOT NULL DEFAULT 'paid',
  ADD COLUMN paid_at            DATE,
  -- cash · card · bank_transfer · direct_debit · other
  ADD COLUMN payment_method     TEXT,
  ADD COLUMN due_date           DATE,
  ADD COLUMN cash_movement_id   UUID REFERENCES cash_movements(id) ON DELETE SET NULL;

-- Los gastos que ya había se daban por pagados el día del gasto.
UPDATE expenses SET paid_at = expense_date WHERE paid_at IS NULL;

CREATE INDEX expenses_tenant_payment_idx ON expenses (tenant_id, payment_status, due_date);
CREATE INDEX expenses_tenant_supplier_idx ON expenses (tenant_id, supplier_id);

-- Recurrentes: cada mes, cada trimestre o cada año, con inicio y fin,
-- proveedor, desglose y forma de pago.
ALTER TABLE recurring_expenses
  ADD COLUMN frequency         TEXT NOT NULL DEFAULT 'monthly',
  ADD COLUMN start_date        DATE,
  ADD COLUMN end_date          DATE,
  ADD COLUMN supplier_id       UUID REFERENCES expense_suppliers(id) ON DELETE SET NULL,
  ADD COLUMN vendor            TEXT,
  ADD COLUMN vendor_tax_id     TEXT,
  ADD COLUMN base_amount       NUMERIC(12, 2),
  ADD COLUMN vat_rate          NUMERIC(5, 2),
  ADD COLUMN vat_deductible    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN withholding_rate  NUMERIC(5, 2),
  ADD COLUMN withholding_model TEXT,
  -- Con domiciliación o tarjeta el gasto nace pagado; si no, pendiente.
  ADD COLUMN payment_method    TEXT;

-- Las que ya había empiezan el mes en que se crearon.
UPDATE recurring_expenses
  SET start_date = date_trunc('month', created_at)::date
  WHERE start_date IS NULL;
