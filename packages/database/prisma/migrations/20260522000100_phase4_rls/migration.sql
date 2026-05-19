-- RLS para tablas de Fase 4. Patron identico al resto: el rol app
-- solo ve filas cuyo tenant_id coincida con app.current_tenant.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'invoice_series',
        'invoices',
        'invoice_items',
        'payments',
        'payment_methods',
        'dunning_actions',
        'pricing_rules',
        'promotions',
        'data_subject_requests',
        'consents'
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
