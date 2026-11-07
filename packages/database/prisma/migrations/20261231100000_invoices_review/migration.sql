-- Revisión de Facturas del panel del tenant.

-- Plazo de pago, contado desde la emisión.
ALTER TABLE tenants ADD COLUMN invoice_due_days INTEGER NOT NULL DEFAULT 15;

-- Lo que gastó la factura al crearse (mes gratis, señal de la reserva): si se
-- cancela o se anula, vuelve al contrato.
ALTER TABLE invoices ADD COLUMN consumed_benefits JSONB;

-- Cada devolución de una factura: cómo se hizo y quién la registró.
CREATE TABLE invoice_refunds (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id         UUID REFERENCES payments(id) ON DELETE SET NULL,
  amount             DECIMAL(12, 2) NOT NULL,
  -- gateway: la devolvió la pasarela · bank: se devolvió en el banco y aquí se
  -- registra · manual: efectivo o transferencia · external: hecha fuera de la app.
  via                TEXT NOT NULL,
  reason             TEXT,
  gateway_refund_id  TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX invoice_refunds_invoice_idx ON invoice_refunds (invoice_id, created_at DESC);
CREATE INDEX invoice_refunds_tenant_idx ON invoice_refunds (tenant_id);

ALTER TABLE invoice_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_refunds FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_refunds TO storageos_app;
