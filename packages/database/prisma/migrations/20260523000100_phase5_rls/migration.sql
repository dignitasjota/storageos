-- RLS para tablas de Fase 5. Patron identico al resto: el rol app
-- solo ve filas cuyo tenant_id coincida con app.current_tenant.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'leads',
        'message_templates',
        'communications',
        'automation_rules',
        'automation_runs'
    ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                FOR ALL
                TO storageos_app
                USING (tenant_id = current_setting(''app.current_tenant'', true)::uuid)
                WITH CHECK (tenant_id = current_setting(''app.current_tenant'', true)::uuid)',
            t
        );
    END LOOP;
END $$;
