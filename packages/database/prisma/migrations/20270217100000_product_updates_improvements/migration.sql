-- Mejoras de «Novedades».

-- Novedades dirigidas: solo a unos planes (slugs) y/o unos roles; vacío = todos.
ALTER TABLE product_updates
  ADD COLUMN target_plans TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN target_roles TEXT[] NOT NULL DEFAULT '{}';

-- Resumen mensual por correo: mes (AAAA-MM) del último enviado a cada usuario.
-- Reserva por usuario y mes: aunque dos réplicas lo lancen, solo sale uno.
ALTER TABLE users ADD COLUMN product_updates_digest_month TEXT;

-- «¿Te ha sido útil?»: una reacción por usuario y novedad.
CREATE TABLE product_update_reactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_update_id UUID NOT NULL REFERENCES product_updates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (value IN ('up', 'down')),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_update_reactions_product_update_id_user_id_key
  ON product_update_reactions (product_update_id, user_id);
CREATE INDEX product_update_reactions_tenant_id_idx ON product_update_reactions (tenant_id);
ALTER TABLE product_update_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_update_reactions FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON product_update_reactions TO storageos_app;

-- Pruebas gratis de extras que ha tenido cada negocio (la del super admin y la
-- de autoservicio desde una novedad). Se conserva al caducar la prueba: el
-- autoservicio solo permite una por extra y negocio.
CREATE TABLE tenant_addon_trials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  addon_id UUID NOT NULL REFERENCES subscription_addons(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'self')),
  started_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ(6) NOT NULL
);
CREATE UNIQUE INDEX tenant_addon_trials_tenant_id_addon_id_key
  ON tenant_addon_trials (tenant_id, addon_id);
ALTER TABLE tenant_addon_trials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_addon_trials FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_addon_trials TO storageos_app;

-- Las pruebas que siguen en marcha cuentan como ya probadas.
INSERT INTO tenant_addon_trials (tenant_id, addon_id, source, started_at, expires_at)
SELECT tenant_id, trial_addon_id, 'admin', created_at, COALESCE(expires_at, now())
FROM tenant_feature_overrides
WHERE source = 'trial' AND trial_addon_id IS NOT NULL
ON CONFLICT (tenant_id, addon_id) DO NOTHING;
