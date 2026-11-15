-- Mejoras de Leads, Seguimientos y Oportunidades (2026-11-15).

-- Contactos: dirección de respuesta propia (lo que conteste al correo vuelve a
-- su ficha) y secuencia automática de correos a los contactos nuevos.
ALTER TABLE leads ADD COLUMN reply_token TEXT;
CREATE UNIQUE INDEX leads_reply_token_key ON leads (reply_token);
ALTER TABLE leads ADD COLUMN nurture_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN nurture_last_at TIMESTAMPTZ;

ALTER TABLE tenants ADD COLUMN lead_nurture_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN lead_use_business_hours BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN lead_quote_reminder_days INTEGER NOT NULL DEFAULT 3;

-- Presupuestos enviados a un contacto.
CREATE TABLE lead_quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id) ON DELETE SET NULL,
  unit_type_id UUID REFERENCES unit_types(id) ON DELETE SET NULL,
  months INTEGER NOT NULL DEFAULT 1,
  coupon_code TEXT,
  total_to_pay NUMERIC(10, 2) NOT NULL,
  monthly_with_vat NUMERIC(10, 2) NOT NULL,
  book_url TEXT NOT NULL,
  -- email | whatsapp
  channel TEXT NOT NULL DEFAULT 'email',
  sent_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_sent_at TIMESTAMPTZ,
  booked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_quotes_lead_idx ON lead_quotes (lead_id, sent_at DESC);
CREATE INDEX lead_quotes_reminder_idx ON lead_quotes (tenant_id, sent_at)
  WHERE reminder_sent_at IS NULL AND booked_at IS NULL;
ALTER TABLE "lead_quotes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "lead_quotes";
CREATE POLICY tenant_isolation ON "lead_quotes" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Visitas al local de un contacto.
CREATE TABLE lead_visits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  -- scheduled | done | no_show | cancelled
  status TEXT NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_visits_lead_idx ON lead_visits (lead_id, scheduled_at DESC);
CREATE INDEX lead_visits_upcoming_idx ON lead_visits (tenant_id, scheduled_at)
  WHERE status = 'scheduled';
ALTER TABLE "lead_visits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "lead_visits";
CREATE POLICY tenant_isolation ON "lead_visits" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Seguimientos: responsable y resultado al marcarlos hechos.
ALTER TABLE lead_followups ADD COLUMN assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lead_followups ADD COLUMN outcome TEXT;
ALTER TABLE customer_followups ADD COLUMN assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customer_followups ADD COLUMN outcome TEXT;
CREATE INDEX lead_followups_pending_idx ON lead_followups (tenant_id, due_date) WHERE status = 'pending';
CREATE INDEX customer_followups_pending_idx ON customer_followups (tenant_id, due_date) WHERE status = 'pending';

-- Oportunidades descartadas o pospuestas.
CREATE TABLE opportunity_dismissals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- null = para siempre
  until TIMESTAMPTZ,
  reason TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX opportunity_dismissals_key ON opportunity_dismissals (tenant_id, customer_id, kind);
ALTER TABLE "opportunity_dismissals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "opportunity_dismissals";
CREATE POLICY tenant_isolation ON "opportunity_dismissals" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
