-- Mejoras del soporte del panel del tenant.
--
-- 1. Desde dónde se escribe el ticket (pantalla y navegador) y lo que respondió
--    el asistente antes de abrirlo, para que el soporte no pregunte lo mismo.
ALTER TABLE support_tickets ADD COLUMN page_url TEXT;
ALTER TABLE support_tickets ADD COLUMN user_agent TEXT;
ALTER TABLE support_tickets ADD COLUMN screen_size TEXT;
ALTER TABLE support_tickets ADD COLUMN ai_answer TEXT;

-- 2. Compañeros en copia: reciben por correo los avisos del ticket.
CREATE TABLE support_ticket_watchers (
  ticket_id  UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX support_ticket_watchers_tenant_user_idx ON support_ticket_watchers (tenant_id, user_id);

ALTER TABLE support_ticket_watchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ticket_watchers FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON support_ticket_watchers TO storageos_app;

-- 3. Estado del servicio que publica el super admin (un solo registro) y el
--    historial de incidencias. Tablas globales del panel de administración.
CREATE TABLE platform_service_status (
  id              UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- ok · degraded · incident
  status          TEXT NOT NULL DEFAULT 'ok',
  message         TEXT,
  since           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_service_status_pkey PRIMARY KEY (id),
  CONSTRAINT platform_service_status_status_check CHECK (status IN ('ok', 'degraded', 'incident'))
);
REVOKE ALL ON platform_service_status FROM storageos_app;

CREATE TABLE platform_service_incidents (
  id              UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- degraded · incident (el peor que llegó a tener)
  status          TEXT NOT NULL,
  message         TEXT,
  started_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ(6),
  created_by_name TEXT,
  CONSTRAINT platform_service_incidents_pkey PRIMARY KEY (id),
  CONSTRAINT platform_service_incidents_status_check CHECK (status IN ('degraded', 'incident'))
);
CREATE INDEX platform_service_incidents_started_idx ON platform_service_incidents (started_at DESC);
REVOKE ALL ON platform_service_incidents FROM storageos_app;
