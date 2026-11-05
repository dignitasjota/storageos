-- Mejoras de la mensajería: estado y responsable por conversación, notas
-- internas, respuestas guardadas, varios adjuntos, respuesta por correo,
-- horario de atención y valoración de tickets.

CREATE TABLE customer_conversations (
  customer_id      UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending',
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reply_token      TEXT UNIQUE,
  closed_at        TIMESTAMPTZ(6),
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX customer_conversations_tenant_status_idx ON customer_conversations (tenant_id, status);
CREATE INDEX customer_conversations_assigned_idx ON customer_conversations (tenant_id, assigned_user_id);

CREATE TABLE customer_canned_responses (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX customer_canned_responses_tenant_idx ON customer_canned_responses (tenant_id);

ALTER TABLE customer_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_conversations FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE customer_canned_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_canned_responses FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON customer_conversations, customer_canned_responses
  TO storageos_app;

ALTER TABLE customer_messages
  ADD COLUMN is_internal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_auto BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN extra_attachments JSONB NOT NULL DEFAULT '[]';

ALTER TABLE support_ticket_messages
  ADD COLUMN extra_attachments JSONB NOT NULL DEFAULT '[]';

ALTER TABLE support_tickets
  ADD COLUMN rating INTEGER,
  ADD COLUMN rating_comment TEXT,
  ADD COLUMN rated_at TIMESTAMPTZ(6),
  ADD COLUMN reply_token TEXT UNIQUE,
  ADD COLUMN waiting_reminded_at TIMESTAMPTZ(6);

ALTER TABLE communications ADD COLUMN reply_to TEXT;

ALTER TABLE tenants
  ADD COLUMN message_hours JSONB,
  ADD COLUMN message_auto_reply_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN message_auto_reply TEXT;

-- Las conversaciones que ya existen: pendientes si lo último es del inquilino.
INSERT INTO customer_conversations (customer_id, tenant_id, status)
SELECT DISTINCT ON (m.customer_id)
  m.customer_id,
  m.tenant_id,
  CASE WHEN m.sender_type = 'customer' THEN 'pending' ELSE 'answered' END
FROM customer_messages m
ORDER BY m.customer_id, m.created_at DESC, m.id DESC;
