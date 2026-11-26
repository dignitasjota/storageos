-- SEO Avanzado, PR 7: importación de los Excel maestros (§8 y §18).
--
-- Un maestro es un Excel con el catálogo de palabras (grupo, intención,
-- prioridad y URL objetivo propuestos), las métricas de SISTRIX y de Search
-- Console, los rankings de la competencia, los grupos, el plan de acción y las
-- pestañas de una exportación de Search Console.
--
-- `seo_master_imports`: cada maestro importado, con su Resumen y sus reglas
-- (Fuentes_importacion) y lo que hizo cada hoja.
-- `seo_master_import_items`: lo que creó o rellenó, con los valores que puso,
-- para poder deshacerlo al borrar la importación sin tocar lo que se haya
-- cambiado a mano después.
-- `seo_keyword_groups`: los grupos del catálogo (hoja Clusters) con su
-- prioridad, URL objetivo principal y nota. Hasta ahora el grupo era solo un
-- texto en cada palabra.
--
-- Las observaciones que añade (métricas de palabras, palabras de un dominio y
-- la importación de Search Console) se borran con ella; lo que crea en el
-- catálogo, la competencia y las tareas queda con su origen (`SET NULL` al
-- borrarla: lo que no se borra porque se tocó a mano sigue).
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

CREATE TABLE "seo_master_imports" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID NOT NULL,
  "file_name" TEXT NOT NULL,
  "file_hash" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL DEFAULT 0,
  -- El dominio del Resumen.
  "domain" TEXT NOT NULL,
  "extracted_at" DATE,
  "gsc_from" DATE,
  "gsc_to" DATE,
  -- Hoja Resumen (indicador, valor, nota) y Fuentes_importacion (campo, regla, fuente).
  "summary" JSONB NOT NULL DEFAULT '[]',
  "rules" JSONB NOT NULL DEFAULT '[]',
  -- Por hoja: filas, creadas, actualizadas, omitidas y por qué.
  "sheets" JSONB NOT NULL DEFAULT '[]',
  -- Filas rechazadas o con avisos (las primeras) y cuántas hubo.
  "issues" JSONB NOT NULL DEFAULT '[]',
  "issues_total" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_master_imports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_master_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_master_imports_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_master_imports_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_master_imports_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_master_imports_created_by_super_admin_id_fkey" FOREIGN KEY ("created_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_master_imports_project_hash_key"
  ON "seo_master_imports" ("project_id", "file_hash");
CREATE INDEX "seo_master_imports_project_created_idx"
  ON "seo_master_imports" ("project_id", "created_at" DESC);
CREATE INDEX "seo_master_imports_tenant_idx" ON "seo_master_imports" ("tenant_id");

ALTER TABLE "seo_master_imports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_master_imports" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "seo_master_import_items" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "import_id" UUID NOT NULL,
  -- keyword_created · keyword_filled · competitor_created · competitor_filled ·
  -- task_created · group_created · group_filled
  "kind" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  -- keyword_id del maestro, dominio, id del plan (P01) o nombre del grupo.
  "ref" TEXT NOT NULL DEFAULT '',
  -- Los valores que puso la importación (para saber si se tocaron después).
  "fields" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_master_import_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_master_import_items_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_master_import_items_import_id_fkey" FOREIGN KEY ("import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "seo_master_import_items_import_idx" ON "seo_master_import_items" ("import_id", "kind");
CREATE INDEX "seo_master_import_items_tenant_idx" ON "seo_master_import_items" ("tenant_id");

ALTER TABLE "seo_master_import_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_master_import_items" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "seo_keyword_groups" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  -- 1 alta · 2 media · 3 baja (null = sin decidir)
  "priority" INTEGER,
  "target_url" TEXT,
  "notes" TEXT,
  -- manual · master
  "source" TEXT NOT NULL DEFAULT 'manual',
  "master_import_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_keyword_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_keyword_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_keyword_groups_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_keyword_groups_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_keyword_groups_project_name_key"
  ON "seo_keyword_groups" ("project_id", "name");
CREATE INDEX "seo_keyword_groups_tenant_idx" ON "seo_keyword_groups" ("tenant_id");

ALTER TABLE "seo_keyword_groups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_keyword_groups" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- Origen de lo que crea un maestro en el catálogo, la competencia y las tareas.
ALTER TABLE "seo_project_keywords" ADD COLUMN "master_import_id" UUID;
ALTER TABLE "seo_project_keywords"
  ADD CONSTRAINT "seo_project_keywords_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "seo_competitors" ADD COLUMN "master_import_id" UUID;
ALTER TABLE "seo_competitors"
  ADD CONSTRAINT "seo_competitors_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- `external_ref`: el id del plan del maestro (P01…), para no duplicar al reimportar.
ALTER TABLE "seo_tasks" ADD COLUMN "external_ref" TEXT;
ALTER TABLE "seo_tasks" ADD COLUMN "master_import_id" UUID;
ALTER TABLE "seo_tasks"
  ADD CONSTRAINT "seo_tasks_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "seo_tasks_external_ref_idx" ON "seo_tasks" ("project_id", "external_ref");

-- Las observaciones que añade se van con ella (el histórico de SISTRIX y de
-- Google no se toca: son filas aparte con su proveedor).
ALTER TABLE "seo_keyword_metrics" ADD COLUMN "master_import_id" UUID;
ALTER TABLE "seo_keyword_metrics"
  ADD CONSTRAINT "seo_keyword_metrics_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "seo_keyword_metrics_master_import_idx" ON "seo_keyword_metrics" ("master_import_id");

ALTER TABLE "seo_domain_keywords" ADD COLUMN "master_import_id" UUID;
ALTER TABLE "seo_domain_keywords"
  ADD CONSTRAINT "seo_domain_keywords_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "seo_domain_keywords_master_import_idx" ON "seo_domain_keywords" ("master_import_id");

-- Las pestañas de Search Console del maestro entran como una importación de la PR 2.
ALTER TABLE "seo_gsc_imports" ADD COLUMN "master_import_id" UUID;
ALTER TABLE "seo_gsc_imports"
  ADD CONSTRAINT "seo_gsc_imports_master_import_id_fkey" FOREIGN KEY ("master_import_id")
    REFERENCES "seo_master_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
