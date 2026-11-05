-- Revisión de la mensajería: el leído de tickets y de los mensajes de TrasterOS
-- pasa a ser por persona (antes el primero que los abría los marcaba para todos).

CREATE TABLE support_ticket_reads (
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX support_ticket_reads_tenant_user_idx ON support_ticket_reads (tenant_id, user_id);

CREATE TABLE tenant_platform_message_reads (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX tenant_platform_message_reads_tenant_idx ON tenant_platform_message_reads (tenant_id);

ALTER TABLE support_ticket_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ticket_reads FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE tenant_platform_message_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_platform_message_reads FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Lo que ya estaba leído sigue leído para el equipo actual.
INSERT INTO tenant_platform_message_reads (user_id, tenant_id, last_read_at)
SELECT u.id, u.tenant_id, m.last_read
FROM users u
JOIN (
  SELECT tenant_id, max(read_at) AS last_read
  FROM tenant_platform_messages
  WHERE read_at IS NOT NULL
  GROUP BY tenant_id
) m ON m.tenant_id = u.tenant_id;

GRANT SELECT, INSERT, UPDATE, DELETE ON support_ticket_reads, tenant_platform_message_reads TO storageos_app;
