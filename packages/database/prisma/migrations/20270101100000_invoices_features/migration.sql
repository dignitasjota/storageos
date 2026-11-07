-- Facturas, PR B (mejoras).

-- Plazo de pago propio de un inquilino (null = el del negocio).
ALTER TABLE customers ADD COLUMN invoice_due_days INTEGER;

-- Saldo a favor del inquilino: una devolución que se descuenta de su próxima
-- factura (la paga en parte al emitirse).
ALTER TABLE contracts ADD COLUMN credit_balance DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Vistas guardadas de la lista de facturas, compartidas por el equipo.
CREATE TABLE invoice_saved_views (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  filters            JSONB NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE invoice_saved_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_saved_views FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_saved_views TO storageos_app;

-- El historial de una factura (y de cualquier ficha) se busca por su id.
CREATE INDEX "audit_logs_tenant_entity_idx" ON "audit_logs" ("tenant_id", "entity_type", "entity_id");
