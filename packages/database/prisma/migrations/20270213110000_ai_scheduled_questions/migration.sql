-- Preguntas al asistente que se hacen solas (cada día o cada semana) y llegan
-- por correo a quien las programó.
CREATE TABLE ai_scheduled_questions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  frequency    TEXT NOT NULL,
  weekday      INTEGER,
  hour         INTEGER NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  next_run_at  TIMESTAMPTZ(6) NOT NULL,
  last_run_at  TIMESTAMPTZ(6),
  last_conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
  last_error   TEXT,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX ai_scheduled_questions_due_idx ON ai_scheduled_questions (next_run_at) WHERE is_active;
CREATE INDEX ai_scheduled_questions_user_idx ON ai_scheduled_questions (tenant_id, user_id);

ALTER TABLE ai_scheduled_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_scheduled_questions FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_scheduled_questions TO storageos_app;
