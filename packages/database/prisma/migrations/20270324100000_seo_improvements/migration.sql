-- SEO Avanzado: mejoras (2026-11-26).

-- Mejora 5: municipios y barrios que le importan al proyecto (lista, no texto libre).
ALTER TABLE "seo_projects" ADD COLUMN "local_areas" TEXT[] NOT NULL DEFAULT '{}';

-- Mejora 4: título del resultado de Google (cuando el proveedor lo da, desde ahora).
-- Mejora 8: de qué importación de CSV de SISTRIX viene (se borra con ella).
ALTER TABLE "seo_serp_results"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "sistrix_import_id" UUID;
ALTER TABLE "seo_domain_keywords" ADD COLUMN "sistrix_import_id" UUID;

-- Mejora 14: competidor de un directorio (competidor.es/valencia/): su análisis se acota a la ruta.
ALTER TABLE "seo_competitors" ADD COLUMN "path_prefix" TEXT;

-- Mejora 2: semana del último aviso del 80 % del presupuesto (uno por semana).
ALTER TABLE "seo_provider_connections" ADD COLUMN "budget_alert_week" DATE;

-- Mejora 6: anotaciones propuestas desde el registro de actividad (y confirmadas).
ALTER TABLE "seo_changes"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "source_ref" TEXT;
CREATE UNIQUE INDEX "seo_changes_source_ref_key" ON "seo_changes" ("project_id", "source_ref")
  WHERE "source_ref" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Propuestas de anotación descartadas (para no volver a proponerlas).
-- ---------------------------------------------------------------------------
CREATE TABLE "seo_annotation_dismissals" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "source_ref" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_annotation_dismissals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_annotation_dismissals_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_annotation_dismissals_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_annotation_dismissals_key" ON "seo_annotation_dismissals" ("project_id", "source_ref");
CREATE INDEX "seo_annotation_dismissals_tenant_idx" ON "seo_annotation_dismissals" ("tenant_id");
ALTER TABLE "seo_annotation_dismissals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_annotation_dismissals" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Mejora 8: importaciones de CSV de SISTRIX (quién, cuándo, qué y cuántas filas).
-- ---------------------------------------------------------------------------
CREATE TABLE "seo_sistrix_imports" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- domain_keywords · serp · competitors
  "kind" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "domain" TEXT,
  "keyword" TEXT,
  "country" TEXT NOT NULL DEFAULT 'ES',
  "rows" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_sistrix_imports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_sistrix_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_sistrix_imports_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "seo_sistrix_imports_project_idx" ON "seo_sistrix_imports" ("project_id", "created_at" DESC);
CREATE INDEX "seo_sistrix_imports_tenant_idx" ON "seo_sistrix_imports" ("tenant_id");
ALTER TABLE "seo_sistrix_imports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_sistrix_imports" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "seo_serp_results" ADD CONSTRAINT "seo_serp_results_import_fkey"
  FOREIGN KEY ("sistrix_import_id") REFERENCES "seo_sistrix_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seo_domain_keywords" ADD CONSTRAINT "seo_domain_keywords_import_fkey"
  FOREIGN KEY ("sistrix_import_id") REFERENCES "seo_sistrix_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "seo_serp_results_import_idx" ON "seo_serp_results" ("sistrix_import_id");
CREATE INDEX "seo_domain_keywords_import_idx" ON "seo_domain_keywords" ("sistrix_import_id");

-- ---------------------------------------------------------------------------
-- Mejora 2: muestras de la API clásica de SISTRIX (respuesta real de una consulta
-- autorizada). Tabla global: solo de la plataforma.
-- ---------------------------------------------------------------------------
CREATE TABLE "seo_api_samples" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "method" TEXT NOT NULL,
  "params" JSONB NOT NULL DEFAULT '{}',
  "response" JSONB,
  "credits" INTEGER NOT NULL DEFAULT 0,
  "credits_known" BOOLEAN NOT NULL DEFAULT false,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_api_samples_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "seo_api_samples" FROM storageos_app;
