-- Mejoras de Configuración del panel del tenant.

-- Invitar con rol a medida y locales.
ALTER TABLE invitations
  ADD COLUMN tenant_role_id UUID REFERENCES tenant_roles(id) ON DELETE SET NULL,
  ADD COLUMN facility_ids UUID[] NOT NULL DEFAULT '{}';

-- Protección de datos: fecha de recepción y motivo al denegar.
ALTER TABLE data_subject_requests
  ADD COLUMN received_at TIMESTAMPTZ(6),
  ADD COLUMN rejection_reason TEXT;

-- Preguntas frecuentes en inglés.
ALTER TABLE faq_entries
  ADD COLUMN question_en TEXT,
  ADD COLUMN answer_en TEXT;

-- Publicación programada del blog.
ALTER TABLE blog_posts ADD COLUMN publish_at TIMESTAMPTZ(6);
CREATE INDEX blog_posts_publish_at_idx ON blog_posts (publish_at) WHERE publish_at IS NOT NULL;

-- Recordatorios del escalado por WhatsApp y dirección de respuesta de los correos.
ALTER TABLE tenants
  ADD COLUMN dunning_whatsapp_reminders BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN email_reply_to TEXT;

-- Direcciones antiguas de entradas del blog y landings (redirigen a la nueva).
CREATE TABLE web_slug_redirects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('blog', 'promo')),
  old_slug TEXT NOT NULL,
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX web_slug_redirects_tenant_id_kind_old_slug_key
  ON web_slug_redirects (tenant_id, kind, old_slug);
CREATE INDEX web_slug_redirects_target_id_idx ON web_slug_redirects (target_id);
ALTER TABLE web_slug_redirects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON web_slug_redirects FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON web_slug_redirects TO storageos_app;
