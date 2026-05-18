-- RLS para la tabla `sessions`. Misma politica que el resto del nucleo:
-- el rol `storageos_app` solo ve y modifica filas cuyo `tenant_id` coincida
-- con `app.current_tenant`. El rol admin (`storageos`) sigue bypasseando
-- por ser owner.

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
