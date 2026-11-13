-- Fiscalidad: cierre de trimestres y envío automático a la asesoría
-- (2026-11-13).

-- Cierre de un trimestre: foto de las cifras al cerrarlo; mientras no se
-- reabra, los gastos y anulaciones de ese periodo no se pueden cambiar.
CREATE TABLE fiscal_period_closures (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year                INTEGER NOT NULL,
  quarter             INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  closed_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  closed_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  snapshot            JSONB NOT NULL,
  reopened_at         TIMESTAMPTZ(6),
  reopened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reopen_reason       TEXT
);
-- Un cierre vigente por trimestre.
CREATE UNIQUE INDEX fiscal_period_closures_open_key
  ON fiscal_period_closures (tenant_id, year, quarter) WHERE reopened_at IS NULL;

ALTER TABLE fiscal_period_closures ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_period_closures FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_period_closures TO storageos_app;

-- Envío automático a la asesoría (cada mes o cada trimestre).
ALTER TABLE tenants
  ADD COLUMN accountant_email            TEXT,
  ADD COLUMN accountant_report_frequency TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN accountant_report_last_period TEXT;
