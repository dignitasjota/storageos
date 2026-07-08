-- Cierre de caja diario (arqueo de efectivo): el operador cuadra el efectivo
-- contado físicamente contra lo registrado (pagos `cash` del día). Uno por día
-- y tenant (caja global). `difference` = contado − esperado.
CREATE TABLE "cash_closures" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "closure_date" DATE NOT NULL,
    "expected_cash" DECIMAL(10, 2) NOT NULL DEFAULT 0,
    "counted_cash" DECIMAL(10, 2) NOT NULL DEFAULT 0,
    "difference" DECIMAL(10, 2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "cash_closures_pkey" PRIMARY KEY ("id")
);

-- Un solo cierre por día y tenant (idempotencia).
CREATE UNIQUE INDEX "cash_closures_tenant_date_key" ON "cash_closures" ("tenant_id", "closure_date");

ALTER TABLE "cash_closures"
    ADD CONSTRAINT "cash_closures_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cash_closures"
    ADD CONSTRAINT "cash_closures_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cash_closures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "cash_closures";
CREATE POLICY tenant_isolation ON "cash_closures" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
