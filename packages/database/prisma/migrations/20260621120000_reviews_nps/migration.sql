-- Crecimiento/CRM: Reviews / NPS post-contratación.
--
-- Recoge la satisfacción del inquilino (NPS 0-10 + estrellas 1-5 + comentario)
-- mediante un enlace público con token. La solicitud puede ser manual (staff)
-- o automática (cron N días tras firmar, opt-in por tenant).

-- Nuevos triggers de automations para el ciclo de valoración.
ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'review_request';
ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'review_submitted';

CREATE TABLE "reviews" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "contract_id" UUID,
  "token" TEXT NOT NULL,
  "token_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "nps_score" INTEGER,
  "rating" INTEGER,
  "comment" TEXT,
  "channel" TEXT,
  "source" TEXT,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "submitted_at" TIMESTAMPTZ(6),
  "ip" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviews_nps_score_range" CHECK ("nps_score" IS NULL OR ("nps_score" BETWEEN 0 AND 10)),
  CONSTRAINT "reviews_rating_range" CHECK ("rating" IS NULL OR ("rating" BETWEEN 1 AND 5))
);

CREATE UNIQUE INDEX "reviews_token_key" ON "reviews"("token");
CREATE INDEX "reviews_tenant_id_status_idx" ON "reviews"("tenant_id", "status");
CREATE INDEX "reviews_tenant_id_created_at_idx" ON "reviews"("tenant_id", "created_at");
CREATE INDEX "reviews_contract_id_idx" ON "reviews"("contract_id");

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "reviews";
CREATE POLICY tenant_isolation ON "reviews"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Auto-solicitud de valoración (opt-in por tenant).
ALTER TABLE "tenants" ADD COLUMN "reviews_auto_request" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "review_request_delay_days" INTEGER NOT NULL DEFAULT 14;
