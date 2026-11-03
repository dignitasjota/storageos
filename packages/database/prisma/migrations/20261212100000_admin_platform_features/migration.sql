-- Mejoras de «Plataforma» del panel admin.

-- Formulario de contacto: nota, quién lo lleva y respuesta desde el panel.
ALTER TABLE platform_contact_messages
  ADD COLUMN note TEXT,
  ADD COLUMN assigned_to_id UUID REFERENCES super_admins(id) ON DELETE SET NULL,
  ADD COLUMN replied_at TIMESTAMPTZ(6),
  ADD COLUMN reply_subject TEXT,
  ADD COLUMN reply_body TEXT;

-- Textos de la portada de trasteros.pro (null = los de serie).
ALTER TABLE platform_website ADD COLUMN home JSONB;

-- Versiones de las páginas legales.
CREATE TABLE platform_legal_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by_id UUID REFERENCES super_admins(id) ON DELETE SET NULL,
  notify_tenants BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX platform_legal_versions_slug_idx ON platform_legal_versions (slug, created_at DESC);

-- Aceptación por los tenants de una versión que se les pidió aceptar.
CREATE TABLE platform_legal_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  version_id UUID NOT NULL REFERENCES platform_legal_versions(id) ON DELETE CASCADE,
  ip_address TEXT,
  accepted_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_legal_acceptances_unique UNIQUE (tenant_id, version_id)
);

-- Asistente IA: aviso de gasto y límite de consultas por plan.
ALTER TABLE platform_ai_settings
  ADD COLUMN monthly_cost_alert_usd DECIMAL(10, 2),
  ADD COLUMN plan_limits JSONB;

-- Alertas: hora del aviso diario y aviso por chat de los mensajes de contacto.
ALTER TABLE platform_alert_settings
  ADD COLUMN daily_hour INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN chat_contact_enabled BOOLEAN NOT NULL DEFAULT true;

-- Historial de avisos al administrador (email y chat).
CREATE TABLE platform_alert_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  error TEXT,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX platform_alert_logs_created_idx ON platform_alert_logs (created_at DESC);

-- Tablas globales: solo la conexión de administración.
REVOKE ALL ON platform_legal_versions FROM storageos_app;
REVOKE ALL ON platform_legal_acceptances FROM storageos_app;
REVOKE ALL ON platform_alert_logs FROM storageos_app;
