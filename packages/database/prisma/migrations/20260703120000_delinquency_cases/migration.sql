-- Expedientes de impago (overlock → requerimiento → disposición). El software
-- ORQUESTA el expediente (plazos, avisos, evidencias, liquidación) con
-- compuertas manuales en cada paso legalmente sensible; NUNCA dispone solo.

-- Máquina de estados del expediente.
CREATE TYPE "delinquency_case_status" AS ENUM (
  'open',
  'overlocked',
  'final_notice',
  'resolution_pending',
  'disposal',
  'closed_paid',
  'closed_disposed',
  'closed_cancelled'
);

-- Config del tenant (opt-in; los plazos los decide su asesoría).
ALTER TABLE "tenants" ADD COLUMN "collections_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "collections_open_after_days" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "tenants" ADD COLUMN "collections_notice_days" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "tenants" ADD COLUMN "collections_clause_ref" TEXT;

-- ============================ delinquency_cases ============================
CREATE TABLE "delinquency_cases" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "unit_id" UUID,
    "facility_id" UUID,
    "status" "delinquency_case_status" NOT NULL DEFAULT 'open',
    -- Snapshot de la deuda (céntimos) al abrir; la deuda viva se recalcula de las facturas.
    "debt_snapshot" INTEGER NOT NULL DEFAULT 0,
    "disposal_type" TEXT,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "overlocked_at" TIMESTAMPTZ(6),
    "final_notice_at" TIMESTAMPTZ(6),
    "final_notice_deadline" TIMESTAMPTZ(6),
    "resolution_pending_at" TIMESTAMPTZ(6),
    "disposed_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "opened_by_user_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "delinquency_cases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delinquency_cases_tenant_id_idx" ON "delinquency_cases" ("tenant_id");
CREATE INDEX "delinquency_cases_tenant_status_idx" ON "delinquency_cases" ("tenant_id", "status");
CREATE INDEX "delinquency_cases_contract_idx" ON "delinquency_cases" ("contract_id");
-- Un único expediente NO cerrado por contrato.
CREATE UNIQUE INDEX "delinquency_cases_open_per_contract_unique"
    ON "delinquency_cases" ("contract_id")
    WHERE "status" NOT IN ('closed_paid', 'closed_disposed', 'closed_cancelled');

ALTER TABLE "delinquency_cases"
    ADD CONSTRAINT "delinquency_cases_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_cases"
    ADD CONSTRAINT "delinquency_cases_contract_id_fkey"
    FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_cases"
    ADD CONSTRAINT "delinquency_cases_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_cases"
    ADD CONSTRAINT "delinquency_cases_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delinquency_cases"
    ADD CONSTRAINT "delinquency_cases_opened_by_user_id_fkey"
    FOREIGN KEY ("opened_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delinquency_cases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "delinquency_cases";
CREATE POLICY tenant_isolation ON "delinquency_cases" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ========================= delinquency_case_events =========================
-- Timeline inmutable del expediente (patrón contract_events).
CREATE TABLE "delinquency_case_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "delinquency_case_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delinquency_case_events_tenant_id_idx" ON "delinquency_case_events" ("tenant_id");
CREATE INDEX "delinquency_case_events_case_idx"
    ON "delinquency_case_events" ("case_id", "occurred_at");

ALTER TABLE "delinquency_case_events"
    ADD CONSTRAINT "delinquency_case_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_case_events"
    ADD CONSTRAINT "delinquency_case_events_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "delinquency_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_case_events"
    ADD CONSTRAINT "delinquency_case_events_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delinquency_case_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "delinquency_case_events";
CREATE POLICY tenant_isolation ON "delinquency_case_events" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ========================= delinquency_case_files ==========================
-- Evidencias en MinIO privado (patrón inspection photos): key del objeto.
CREATE TABLE "delinquency_case_files" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "delinquency_case_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delinquency_case_files_tenant_id_idx" ON "delinquency_case_files" ("tenant_id");
CREATE INDEX "delinquency_case_files_case_idx" ON "delinquency_case_files" ("case_id", "created_at");

ALTER TABLE "delinquency_case_files"
    ADD CONSTRAINT "delinquency_case_files_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_case_files"
    ADD CONSTRAINT "delinquency_case_files_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "delinquency_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delinquency_case_files"
    ADD CONSTRAINT "delinquency_case_files_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delinquency_case_files" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "delinquency_case_files";
CREATE POLICY tenant_isolation ON "delinquency_case_files" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
