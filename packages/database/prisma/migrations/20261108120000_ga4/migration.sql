-- Google Analytics 4 de la web del tenant (dentro de Web Premium). El tenant
-- añade la cuenta de servicio de la plataforma como «Lector» en su propiedad;
-- cada día se guardan sus sesiones por origen y sus páginas vistas.
CREATE TABLE "tenant_ga4" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  -- Número de la propiedad de GA4 (Administrar → Configuración de la propiedad).
  "property_id" TEXT NOT NULL,
  -- pending | connected | error
  "status" TEXT NOT NULL DEFAULT 'pending',
  "last_error" TEXT,
  "connected_at" TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_ga4_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_ga4_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "tenant_ga4_tenant_id_key" ON "tenant_ga4" ("tenant_id");

-- Sesiones por día, origen/medio/campaña y dispositivo.
CREATE TABLE "ga4_source_rows" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "source" TEXT NOT NULL,
  "medium" TEXT NOT NULL,
  "campaign" TEXT NOT NULL,
  "device" TEXT NOT NULL,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  "engaged_sessions" INTEGER NOT NULL DEFAULT 0,
  "page_views" INTEGER NOT NULL DEFAULT 0,
  "key_events" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ga4_source_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ga4_source_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "ga4_source_rows_key" ON "ga4_source_rows" ("tenant_id", "date", "source", "medium", "campaign", "device");

-- Páginas vistas por día y página.
CREATE TABLE "ga4_page_rows" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "page_path" TEXT NOT NULL,
  "page_views" INTEGER NOT NULL DEFAULT 0,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ga4_page_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ga4_page_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "ga4_page_rows_key" ON "ga4_page_rows" ("tenant_id", "date", "page_path");

ALTER TABLE "tenant_ga4" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_ga4" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "ga4_source_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ga4_source_rows" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "ga4_page_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ga4_page_rows" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
