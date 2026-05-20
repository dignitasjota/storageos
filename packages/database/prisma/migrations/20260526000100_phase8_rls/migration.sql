-- RLS Fase 8.
-- super_admins, impersonation_logs: TABLAS GLOBALES sin tenant_id. No RLS.
--   El acceso a estas tablas es solo via `storageos` admin role; el rol
--   `storageos_app` no las consulta nunca.
-- support_tickets, support_ticket_messages: RLS por tenant.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'support_tickets'
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

-- support_ticket_messages: no tiene tenant_id directo. RLS via subquery al ticket.
ALTER TABLE "support_ticket_messages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "support_ticket_messages";
CREATE POLICY tenant_isolation ON "support_ticket_messages"
    FOR ALL
    TO storageos_app
    USING (
        EXISTS (
            SELECT 1 FROM support_tickets st
            WHERE st.id = support_ticket_messages.ticket_id
              AND st.tenant_id = current_setting('app.current_tenant', true)::uuid
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM support_tickets st
            WHERE st.id = support_ticket_messages.ticket_id
              AND st.tenant_id = current_setting('app.current_tenant', true)::uuid
        )
    );
