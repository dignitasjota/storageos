-- Totales de cada día tal como los da Search Console (sin repartir por
-- búsqueda y página). Google omite de las filas por búsqueda las búsquedas
-- poco frecuentes («anonimizadas»), así que sumarlas da menos clics y
-- apariciones que su panel; estos totales cuadran con él.
CREATE TABLE "search_console_days" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "position" DECIMAL(7,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "search_console_days_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "search_console_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "search_console_days_key" ON "search_console_days" ("tenant_id", "date");

ALTER TABLE "search_console_days" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "search_console_days" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
