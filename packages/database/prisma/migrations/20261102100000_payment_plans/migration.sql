-- Plan de pago: el inquilino que debe varias facturas paga la deuda en
-- cuotas. Mientras el plan está activo y al día, el escalado de impagos
-- (recordatorios, recargo, corte de acceso) y los reintentos de cobro de esas
-- facturas se pausan; si una cuota se retrasa más del plazo de gracia el plan
-- se rompe y todo sigue su curso.
CREATE TABLE "payment_plans" (
    "id"                 UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id"          UUID NOT NULL,
    "customer_id"        UUID NOT NULL,
    -- active | completed | broken | cancelled
    "status"             TEXT NOT NULL DEFAULT 'active',
    -- Facturas que cubre el plan.
    "invoice_ids"        UUID[] NOT NULL DEFAULT '{}',
    -- Deuda que se fracciona (pendiente de esas facturas al crearlo).
    "total_amount"       DECIMAL(10,2) NOT NULL,
    -- Lo ya cobrado de esas facturas al crearlo: el avance se mide desde aquí.
    "paid_at_start"      DECIMAL(10,2) NOT NULL DEFAULT 0,
    -- [{ "dueDate": "2026-11-05", "amount": 50.00 }, ...]
    "installments"       JSONB NOT NULL,
    "grace_days"         INTEGER NOT NULL DEFAULT 7,
    "notes"              TEXT,
    "created_by_user_id" UUID,
    "completed_at"       TIMESTAMPTZ(6),
    "broken_at"          TIMESTAMPTZ(6),
    "cancelled_at"       TIMESTAMPTZ(6),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_plans_tenant_status_idx" ON "payment_plans" ("tenant_id", "status");
CREATE INDEX "payment_plans_customer_idx" ON "payment_plans" ("customer_id");
CREATE INDEX "payment_plans_invoice_ids_idx" ON "payment_plans" USING GIN ("invoice_ids");

ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_plans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "payment_plans";
CREATE POLICY tenant_isolation ON "payment_plans" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
