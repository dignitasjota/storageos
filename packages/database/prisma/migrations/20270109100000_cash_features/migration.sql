-- Caja: movimientos (fondo de apertura, entradas de cambio y retiradas al
-- banco) y arqueo por billetes y monedas (2026-11-11).

-- Lo que entra o sale del cajón sin ser un cobro ni una devolución.
CREATE TABLE cash_movements (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = caja de toda la empresa.
  facility_id        UUID REFERENCES facilities(id) ON DELETE CASCADE,
  -- Día del negocio al que pertenece.
  movement_date      DATE NOT NULL,
  -- opening_float (fondo de apertura) · change_in (entrada de cambio)
  -- · bank_withdrawal (retirada al banco)
  kind               TEXT NOT NULL,
  amount             NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  notes              TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX cash_movements_tenant_date_idx ON cash_movements (tenant_id, movement_date);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_movements FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_movements TO storageos_app;

-- El cierre guarda el recuento por billetes y monedas (céntimos → unidades) y
-- de dónde salía el esperado, para imprimirlo tal como se cerró.
ALTER TABLE cash_closures
  ADD COLUMN denominations JSONB,
  ADD COLUMN breakdown JSONB;
