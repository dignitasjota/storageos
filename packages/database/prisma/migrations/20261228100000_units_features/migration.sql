-- Mejoras de Trasteros: características y fotos de cada trastero, motivo de los
-- que están fuera de servicio y vistas guardadas del equipo.

ALTER TABLE units
  ADD COLUMN features TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN images TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN out_of_service_reason TEXT,
  ADD COLUMN out_of_service_since TIMESTAMPTZ(6);

-- Los que ya están parados: desde su último paso a ese estado y con su motivo.
UPDATE units u
SET
  out_of_service_since = COALESCE(last_change.occurred_at, u.updated_at),
  out_of_service_reason = last_change.reason
FROM units src
LEFT JOIN LATERAL (
  SELECT h.occurred_at, h.reason
  FROM unit_status_history h
  WHERE h.unit_id = src.id AND h.new_status = src.status AND h.previous_status <> src.status
  ORDER BY h.occurred_at DESC
  LIMIT 1
) last_change ON true
WHERE u.id = src.id AND u.status IN ('maintenance', 'blocked');

CREATE TABLE unit_saved_views (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  filters            JSONB NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE unit_saved_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON unit_saved_views FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON unit_saved_views TO storageos_app;
