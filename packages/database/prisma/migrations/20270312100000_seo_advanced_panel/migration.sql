-- SEO Avanzado, PR 2: dominios secundarios verificados por el acceso de la
-- cuenta de servicio, importación de los Excel históricos de Search Console y
-- origen de cada fila de los cruces.

-- Cómo se sabe que el dominio es del proyecto: `own` (dominio propio, correo
-- verificado o dirección en la plataforma) o `gsc_access` (secundario que no
-- es «propio» pero la cuenta de servicio tiene acceso a su propiedad y no lo
-- usa nadie más).
ALTER TABLE "seo_project_domains"
  ADD COLUMN "verification" TEXT NOT NULL DEFAULT 'own';

-- Cada Excel (o zip de CSV) importado: sus pestañas, el periodo y los filtros.
CREATE TABLE "seo_gsc_imports" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID NOT NULL,
  "file_name" TEXT NOT NULL,
  -- sha256 del fichero: el mismo fichero no entra dos veces en un proyecto.
  "file_hash" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL DEFAULT 0,
  -- xlsx · zip
  "format" TEXT NOT NULL,
  -- es · en
  "language" TEXT NOT NULL,
  "period_from" DATE NOT NULL,
  "period_to" DATE NOT NULL,
  -- [{ "name": "Tipo de búsqueda", "value": "Web" }, …] tal cual vienen.
  "filters" JSONB NOT NULL DEFAULT '[]',
  -- Lleva un filtro de país, dispositivo, búsqueda, página o tipo distinto de
  -- la web: no es el total del sitio y no entra en el cruce `site`.
  "filtered" BOOLEAN NOT NULL DEFAULT false,
  -- { "query": 1000, "page": 412, … } filas de cada pestaña.
  "tab_rows" JSONB NOT NULL DEFAULT '{}',
  -- Días de la pestaña Fechas: añadidos al cruce `site`, que ya tenía la API y
  -- que ya venían de otra importación.
  "site_days_added" INTEGER NOT NULL DEFAULT 0,
  "site_days_api" INTEGER NOT NULL DEFAULT 0,
  "site_days_imported" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_gsc_imports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_gsc_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_gsc_imports_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_gsc_imports_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_gsc_imports_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_gsc_imports_created_by_super_admin_id_fkey" FOREIGN KEY ("created_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_gsc_imports_project_hash_key"
  ON "seo_gsc_imports" ("project_id", "file_hash");
CREATE INDEX "seo_gsc_imports_project_created_idx"
  ON "seo_gsc_imports" ("project_id", "created_at" DESC);
CREATE INDEX "seo_gsc_imports_tenant_idx" ON "seo_gsc_imports" ("tenant_id");

-- Las pestañas agregadas del periodo (consultas, páginas, países,
-- dispositivos, aspecto en las búsquedas) y la de fechas, tal cual vienen en
-- el Excel. Nunca se reparten por días ni se suman a los datos diarios.
CREATE TABLE "seo_gsc_import_rows" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "import_id" UUID NOT NULL,
  -- query · page · country · device · search_appearance · date
  "dimension" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  -- El CTR y la posición del Excel, solo como referencia.
  "ctr" DECIMAL(7,6),
  "position" DECIMAL(7,2),
  CONSTRAINT "seo_gsc_import_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_gsc_import_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_gsc_import_rows_import_id_fkey" FOREIGN KEY ("import_id")
    REFERENCES "seo_gsc_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "seo_gsc_import_rows_import_dimension_idx"
  ON "seo_gsc_import_rows" ("import_id", "dimension");
CREATE INDEX "seo_gsc_import_rows_tenant_idx" ON "seo_gsc_import_rows" ("tenant_id");

-- De dónde viene cada fila de los cruces: la API (todo lo existente) o una
-- importación (solo el cruce `site`, en los días que la API no tiene). Borrar
-- la importación borra sus días.
ALTER TABLE "seo_gsc_metrics"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'api',
  ADD COLUMN "import_id" UUID,
  ADD CONSTRAINT "seo_gsc_metrics_import_id_fkey" FOREIGN KEY ("import_id")
    REFERENCES "seo_gsc_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "seo_gsc_metrics_import_idx" ON "seo_gsc_metrics" ("import_id")
  WHERE "import_id" IS NOT NULL;

ALTER TABLE "seo_gsc_imports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_gsc_imports" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "seo_gsc_import_rows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_gsc_import_rows" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
