-- RLS para tablas de Fase 6.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'tasks',
        'task_comments',
        'incidents',
        'incident_comments',
        'products',
        'product_stock',
        'product_sales',
        'product_sale_items',
        'report_runs'
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
