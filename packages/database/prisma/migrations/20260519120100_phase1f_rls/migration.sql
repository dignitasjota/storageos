-- RLS para recovery_codes. Misma politica que el resto: el rol app solo ve
-- filas cuyo tenant_id coincida con `app.current_tenant`.

ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recovery_codes;
CREATE POLICY tenant_isolation ON recovery_codes
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
