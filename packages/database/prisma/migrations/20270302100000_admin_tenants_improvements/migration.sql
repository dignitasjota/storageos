-- Mejoras del apartado Tenants del super admin.

-- «Dar de baja» con fecha (hoy o fin del periodo pagado) y anonimización con
-- periodo de gracia: un cron diario aplica las que tocan.
ALTER TABLE tenants
  ADD COLUMN cancel_scheduled_at TIMESTAMPTZ,
  ADD COLUMN cancel_scheduled_reason TEXT,
  ADD COLUMN cancel_scheduled_note TEXT,
  ADD COLUMN cancel_scheduled_by UUID,
  ADD COLUMN anonymize_scheduled_at TIMESTAMPTZ,
  ADD COLUMN anonymize_scheduled_reason TEXT,
  ADD COLUMN anonymize_scheduled_by UUID;
CREATE INDEX tenants_cancel_scheduled_idx ON tenants (cancel_scheduled_at)
  WHERE cancel_scheduled_at IS NOT NULL;
CREATE INDEX tenants_anonymize_scheduled_idx ON tenants (anonymize_scheduled_at)
  WHERE anonymize_scheduled_at IS NOT NULL;

-- Pago manual anulado (no se borra) y si alargó el periodo de la suscripción.
ALTER TABLE tenant_subscription_payments
  ADD COLUMN extended_period BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN void_reason TEXT;
-- Los pagos a mano anteriores que no eran de un extra alargaron el periodo.
UPDATE tenant_subscription_payments
SET extended_period = true
WHERE external_id IS NULL
  AND provider NOT IN ('sepa', 'redsys')
  AND (description IS NULL OR description NOT LIKE 'Add-on:%')
  AND period_start IS NOT NULL
  AND period_end IS NOT NULL;

-- Impersonar como un usuario concreto (null = el propietario).
ALTER TABLE impersonation_logs ADD COLUMN user_id UUID;

-- Estado del tenant cuando se pidió la aprobación (para avisar si cambió).
ALTER TABLE admin_approval_requests ADD COLUMN snapshot JSONB;

-- Las vistas guardadas de la lista guardan también columnas y orden.
ALTER TABLE super_admin_saved_views
  ADD COLUMN columns JSONB,
  ADD COLUMN sort JSONB;

-- Una nota fijada arriba del historial del tenant.
ALTER TABLE tenant_interactions ADD COLUMN pinned_at TIMESTAMPTZ;

-- Exportaciones de los datos de un tenant hechas por el super admin
-- (en segundo plano, con su historial).
CREATE TABLE tenant_data_exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  super_admin_id UUID REFERENCES super_admins(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  file_key TEXT,
  file_bytes INTEGER,
  counts JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX tenant_data_exports_tenant_idx ON tenant_data_exports (tenant_id, created_at DESC);
ALTER TABLE tenant_data_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_data_exports FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
