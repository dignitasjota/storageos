-- Mejoras de Locales: días especiales, cómo llegar, texto alternativo de las
-- fotos, lo que se apagó al borrar (para restaurar) y direcciones antiguas.

ALTER TABLE facilities
  ADD COLUMN opening_exceptions JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN directions TEXT,
  ADD COLUMN maps_url TEXT,
  ADD COLUMN image_alts JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN deleted_snapshot JSONB;

CREATE TABLE facility_slug_redirects (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  old_slug    TEXT NOT NULL,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, old_slug)
);
CREATE INDEX facility_slug_redirects_facility_idx ON facility_slug_redirects (facility_id);

ALTER TABLE facility_slug_redirects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON facility_slug_redirects FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON facility_slug_redirects TO storageos_app;
