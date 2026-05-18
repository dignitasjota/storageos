-- Row-Level Security para el núcleo multi-tenant.
--
-- Convención: en cada request, la app ejecuta
--     SET LOCAL app.current_tenant = '<uuid-del-tenant>'
-- dentro de una transacción. Las políticas leen ese valor con
--     current_setting('app.current_tenant', true)::uuid
-- (el `true` evita el error si la variable no esta definida; en ese caso
-- devuelve NULL, y el filtro `tenant_id = NULL` evalua a NULL, lo que
-- niega el acceso por defecto).
--
-- El OWNER de las tablas (storageos) bypassea RLS por ser superuser; lo
-- usamos para migraciones, seed y operaciones administrativas. El rol
-- `storageos_app` SÍ está sometido a las políticas.
--
-- `subscription_plans` NO lleva RLS: es un catalogo global compartido.

-- ============================================================================
-- tenants
-- ============================================================================

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
    FOR ALL
    TO storageos_app
    USING (id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (id = current_setting('app.current_tenant', true)::uuid);

-- ============================================================================
-- users
-- ============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================================================================
-- tenant_subscriptions
-- ============================================================================

ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_subscriptions;
CREATE POLICY tenant_isolation ON tenant_subscriptions
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================================================================
-- audit_logs
-- ============================================================================

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
