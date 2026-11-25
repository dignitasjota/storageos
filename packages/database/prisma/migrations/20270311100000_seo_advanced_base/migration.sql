-- SEO Avanzado: proyectos, dominios, cruces de Search Console y ejecuciones de
-- la descarga. Un solo motor para dos ámbitos: con `tenant_id` vacío el
-- proyecto es de la plataforma (trasteros.pro, solo lo ve el super admin con la
-- conexión de administración); con valor, es de ese tenant y queda aislado por
-- la política de filas (un `tenant_id` nulo nunca cumple la política, así que
-- el rol de la app no ve nada de la plataforma).

CREATE TABLE "seo_projects" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "name" TEXT NOT NULL,
  "country" TEXT NOT NULL DEFAULT 'ES',
  "language" TEXT NOT NULL DEFAULT 'es',
  "business_type" TEXT,
  -- local · national · international
  "strategy" TEXT NOT NULL DEFAULT 'local',
  "target_location" TEXT,
  "brand_terms" TEXT[] NOT NULL DEFAULT '{}',
  -- Pesos de la puntuación y frecuencias: vacío = los valores por defecto.
  "weights" JSONB NOT NULL DEFAULT '{}',
  "frequencies" JSONB NOT NULL DEFAULT '{}',
  -- active · paused (pausado no descarga)
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_projects_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Un proyecto por tenant como mucho (la plataforma, los que quiera).
CREATE UNIQUE INDEX "seo_projects_tenant_key" ON "seo_projects" ("tenant_id")
  WHERE "tenant_id" IS NOT NULL;

CREATE TABLE "seo_project_domains" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- Copia del dueño del proyecto (para la política de filas).
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- Sin www y en minúsculas.
  "domain" TEXT NOT NULL,
  -- primary · secondary · redirect
  "role" TEXT NOT NULL DEFAULT 'secondary',
  -- `sc-domain:ejemplo.es` o `https://ejemplo.es/`.
  "gsc_property" TEXT NOT NULL,
  -- pending · connected · error
  "connection_status" TEXT NOT NULL DEFAULT 'pending',
  "last_error" TEXT,
  "checked_at" TIMESTAMPTZ(6),
  "connected_at" TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6),
  -- Último día con datos de Google.
  "data_until" DATE,
  -- Terminó la carga de los 16 meses.
  "initial_done_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_project_domains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_project_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_project_domains_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_project_domains_project_domain_key"
  ON "seo_project_domains" ("project_id", "domain");
CREATE INDEX "seo_project_domains_tenant_idx" ON "seo_project_domains" ("tenant_id");
CREATE INDEX "seo_project_domains_property_idx" ON "seo_project_domains" (lower("gsc_property"));

-- Todos los cruces diarios de Search Console en una tabla (`grain`). Las
-- dimensiones que un cruce no tiene van como cadena vacía; el tipo de búsqueda
-- solo se rellena en el cruce `search_type` (el resto son búsquedas web).
CREATE TABLE "seo_gsc_metrics" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "domain_id" UUID NOT NULL,
  -- site · device · country · search_type · query · page · query_page ·
  -- query_device · query_country · page_device
  "grain" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "query" TEXT NOT NULL DEFAULT '',
  "page" TEXT NOT NULL DEFAULT '',
  "country" TEXT NOT NULL DEFAULT '',
  "device" TEXT NOT NULL DEFAULT '',
  "search_type" TEXT NOT NULL DEFAULT '',
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  -- El CTR tal como lo da Google (solo referencia: los agregados se recalculan).
  "ctr" DECIMAL(7,6) NOT NULL DEFAULT 0,
  "position" DECIMAL(7,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_gsc_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_gsc_metrics_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_gsc_metrics_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Clave única por dominio, cruce, fecha y dimensiones. Las URL largas no caben
-- en un índice normal: las dimensiones van resumidas con md5.
CREATE UNIQUE INDEX "seo_gsc_metrics_key" ON "seo_gsc_metrics" (
  "domain_id", "grain", "date",
  md5("query" || chr(31) || "page" || chr(31) || "country" || chr(31) || "device" || chr(31) || "search_type")
);
CREATE INDEX "seo_gsc_metrics_domain_grain_date_idx"
  ON "seo_gsc_metrics" ("domain_id", "grain", "date");
CREATE INDEX "seo_gsc_metrics_grain_date_idx" ON "seo_gsc_metrics" ("grain", "date");
CREATE INDEX "seo_gsc_metrics_tenant_idx" ON "seo_gsc_metrics" ("tenant_id");

-- Cada descarga: progreso por días y cursor para reanudar tras un reinicio.
CREATE TABLE "seo_sync_runs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  -- gsc (más adelante, sistrix)
  "provider" TEXT NOT NULL DEFAULT 'gsc',
  -- initial · daily · manual
  "kind" TEXT NOT NULL,
  -- queued · running · done · failed · cancelled
  "status" TEXT NOT NULL DEFAULT 'queued',
  "range_from" DATE,
  "range_to" DATE,
  "days_total" INTEGER NOT NULL DEFAULT 0,
  "days_done" INTEGER NOT NULL DEFAULT 0,
  -- Ya se descargaron los totales del periodo (site, device, country, search_type).
  "totals_done" BOOLEAN NOT NULL DEFAULT false,
  -- Último día descargado de los cruces con consulta o página (van del más
  -- reciente al más antiguo): al reanudar se sigue por el anterior.
  "cursor" DATE,
  "rows" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "seo_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_sync_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_sync_runs_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_sync_runs_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_sync_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_sync_runs_created_by_super_admin_id_fkey" FOREIGN KEY ("created_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Una descarga viva por dominio y tipo: no se lanza otra mientras tanto.
CREATE UNIQUE INDEX "seo_sync_runs_active_key" ON "seo_sync_runs" ("domain_id", "kind")
  WHERE "status" IN ('queued', 'running');
CREATE INDEX "seo_sync_runs_project_created_idx"
  ON "seo_sync_runs" ("project_id", "created_at" DESC);
CREATE INDEX "seo_sync_runs_tenant_idx" ON "seo_sync_runs" ("tenant_id");

ALTER TABLE "seo_projects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_projects" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "seo_project_domains" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_project_domains" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "seo_gsc_metrics" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_gsc_metrics" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "seo_sync_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_sync_runs" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
