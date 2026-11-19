-- Informes que se envían solos por correo (cada semana o cada mes).
CREATE TABLE report_schedules (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  generator_code     TEXT NOT NULL,
  format             "report_format" NOT NULL,
  -- Parámetros fijos (local, propietario…); las fechas salen del periodo.
  params             JSONB NOT NULL DEFAULT '{}',
  frequency          TEXT NOT NULL,
  weekday            INTEGER,
  day_of_month       INTEGER,
  hour               INTEGER NOT NULL,
  recipients         TEXT[] NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  next_run_at        TIMESTAMPTZ(6) NOT NULL,
  last_run_at        TIMESTAMPTZ(6),
  last_run_id        UUID REFERENCES report_runs(id) ON DELETE SET NULL,
  last_error         TEXT,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX report_schedules_due_idx ON report_schedules (next_run_at) WHERE is_active;
CREATE INDEX report_schedules_tenant_idx ON report_schedules (tenant_id);

ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_schedules FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedules TO storageos_app;
