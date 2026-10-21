-- Extra «SEO local»: seguimiento de posiciones con Google Search Console.
-- El tenant añade la cuenta de servicio de la plataforma como usuario de su
-- propiedad; cada día se guardan sus búsquedas (consulta + página).
CREATE TABLE "tenant_search_console" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  -- Propiedad de Search Console: `sc-domain:ejemplo.es` o `https://ejemplo.es/`.
  "site_url" TEXT NOT NULL,
  -- pending | connected | error
  "status" TEXT NOT NULL DEFAULT 'pending',
  "last_error" TEXT,
  "connected_at" TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_search_console_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_search_console_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "tenant_search_console_tenant_id_key" ON "tenant_search_console" ("tenant_id");

-- Una fila por día, búsqueda y página (lo que devuelve Search Console).
CREATE TABLE "search_console_rows" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "query" TEXT NOT NULL,
  "page" TEXT NOT NULL,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "position" DECIMAL(7,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "search_console_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "search_console_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "search_console_rows_key" ON "search_console_rows" ("tenant_id", "date", "query", "page");
CREATE INDEX "search_console_rows_tenant_date_idx" ON "search_console_rows" ("tenant_id", "date");

ALTER TABLE "tenant_search_console" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_search_console" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "search_console_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "search_console_rows" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
