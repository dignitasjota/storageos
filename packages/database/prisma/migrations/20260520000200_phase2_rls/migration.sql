-- RLS para las tablas de Fase 2. Politica identica que el resto: el rol
-- `storageos_app` solo ve filas cuyo tenant_id coincida con
-- `app.current_tenant`. `facility_floors` no tiene `tenant_id` propio
-- (lo hereda via FK a facility); usamos un EXISTS contra facilities.

ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON facilities;
CREATE POLICY tenant_isolation ON facilities
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON unit_types;
CREATE POLICY tenant_isolation ON unit_types
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON units;
CREATE POLICY tenant_isolation ON units
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE unit_status_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON unit_status_history;
CREATE POLICY tenant_isolation ON unit_status_history
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- facility_floors NO tiene tenant_id; el aislamiento se aplica via la
-- facility a la que pertenece. Un usuario solo ve floors cuyas facilities
-- esten en su tenant.
ALTER TABLE facility_floors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON facility_floors;
CREATE POLICY tenant_isolation ON facility_floors
    FOR ALL
    TO storageos_app
    USING (
        EXISTS (
            SELECT 1 FROM facilities
            WHERE facilities.id = facility_floors.facility_id
              AND facilities.tenant_id = current_setting('app.current_tenant', true)::uuid
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM facilities
            WHERE facilities.id = facility_floors.facility_id
              AND facilities.tenant_id = current_setting('app.current_tenant', true)::uuid
        )
    );
