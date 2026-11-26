-- SEO Avanzado, PR 10 (fase 4): rastreador propio de las webs del proyecto
-- (§9, §11, §15.4, §18.7 y §19.5). Peticiones HTTP sin navegador sin cabeza,
-- solo a los dominios del proyecto, respetando robots.txt.
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

ALTER TABLE "seo_projects"
  -- Rastreo semanal (día y hora), páginas como mucho, pausa y rutas excluidas.
  ADD COLUMN "crawl_settings" JSONB NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Cada rastreo (ejecución). Uno vivo como mucho por proyecto.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_crawls" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- queued · running · done · failed · cancelled
  "status" TEXT NOT NULL DEFAULT 'queued',
  -- manual · scheduled
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "start_url" TEXT NOT NULL,
  -- Host, ruta y protocolo del sitio que se rastrea.
  "site" JSONB NOT NULL DEFAULT '{}',
  "pages_crawled" INTEGER NOT NULL DEFAULT 0,
  -- URL descubiertas (enlaces, mapa del sitio, Search Console).
  "pages_found" INTEGER NOT NULL DEFAULT 0,
  -- Páginas que dan error o no responden.
  "errors" INTEGER NOT NULL DEFAULT 0,
  -- max_pages · max_time (null = recorrió todo).
  "stop_reason" TEXT,
  "error" TEXT,
  -- Incidencias por gravedad y tipo, nuevas, resueltas y las que siguen.
  "summary" JSONB,
  -- robots.txt: si se encontró, sus reglas para este rastreador y lo que bloquea.
  "robots" JSONB,
  -- Mapas del sitio leídos, sus páginas y los que fallaron.
  "sitemaps" JSONB,
  -- Lo necesario para seguir tras un reinicio (robots.txt y las semillas).
  "state" JSONB NOT NULL DEFAULT '{}',
  -- Última señal de vida (un rastreo sin señal en unos minutos se puede retomar).
  "heartbeat_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_crawls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_crawls_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_crawls_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "seo_crawls_project_idx" ON "seo_crawls" ("project_id", "created_at" DESC);
-- Un solo rastreo vivo por proyecto.
CREATE UNIQUE INDEX "seo_crawls_live_key" ON "seo_crawls" ("project_id")
  WHERE "status" IN ('queued', 'running');
CREATE INDEX "seo_crawls_tenant_idx" ON "seo_crawls" ("tenant_id");

ALTER TABLE "seo_crawls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_crawls" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Cada URL de cada rastreo con sus datos clave. Se conservan los 10 últimos
-- rastreos de cada proyecto (de los anteriores queda solo el resumen).
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_crawl_pages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "crawl_id" UUID NOT NULL,
  "url" TEXT NOT NULL,
  -- URL normalizada (sin protocolo, www, barra final ni parámetros de seguimiento).
  "url_key" TEXT NOT NULL,
  -- home · link · sitemap · gsc · finding · canonical
  "source" TEXT NOT NULL DEFAULT 'link',
  -- Del sitio rastreado (si no, solo se pidió para confirmar un hallazgo).
  "in_scope" BOOLEAN NOT NULL DEFAULT true,
  "status" INTEGER,
  "final_status" INTEGER,
  "final_url" TEXT,
  "redirect_chain" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "response_ms" INTEGER,
  "content_type" TEXT,
  "is_html" BOOLEAN NOT NULL DEFAULT false,
  "robots_blocked" BOOLEAN NOT NULL DEFAULT false,
  "google_blocked" BOOLEAN NOT NULL DEFAULT false,
  "robots_rule" TEXT,
  "title" TEXT,
  "description" TEXT,
  "h1" TEXT[] NOT NULL DEFAULT '{}',
  "canonical" TEXT,
  "noindex" BOOLEAN NOT NULL DEFAULT false,
  "nofollow" BOOLEAN NOT NULL DEFAULT false,
  "hreflang" JSONB NOT NULL DEFAULT '[]',
  "json_ld_types" TEXT[] NOT NULL DEFAULT '{}',
  "json_ld_invalid" INTEGER NOT NULL DEFAULT 0,
  "images_total" INTEGER NOT NULL DEFAULT 0,
  "images_without_alt" INTEGER NOT NULL DEFAULT 0,
  -- Enlaces internos (absolutos) y sus claves normalizadas (para los que entran).
  "links" TEXT[] NOT NULL DEFAULT '{}',
  "link_keys" TEXT[] NOT NULL DEFAULT '{}',
  "external_links" INTEGER NOT NULL DEFAULT 0,
  "in_sitemap" BOOLEAN NOT NULL DEFAULT false,
  -- Impresiones de Search Console (90 días) de la URL.
  "impressions" INTEGER NOT NULL DEFAULT 0,
  -- Profundidad de clic desde la portada y enlaces internos que le llegan (al terminar).
  "depth" INTEGER,
  "inlinks" INTEGER NOT NULL DEFAULT 0,
  "issues" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_crawl_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_crawl_pages_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_crawl_pages_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_crawl_pages_crawl_id_fkey" FOREIGN KEY ("crawl_id")
    REFERENCES "seo_crawls" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_crawl_pages_crawl_url_key" ON "seo_crawl_pages" ("crawl_id", "url_key");
CREATE INDEX "seo_crawl_pages_url_idx" ON "seo_crawl_pages"
  ("project_id", "url_key", "created_at" DESC);
-- Los enlaces que llegan a una URL.
CREATE INDEX "seo_crawl_pages_link_keys_idx" ON "seo_crawl_pages" USING GIN ("link_keys");
CREATE INDEX "seo_crawl_pages_tenant_idx" ON "seo_crawl_pages" ("tenant_id");

ALTER TABLE "seo_crawl_pages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_crawl_pages" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Incidencias con histórico: una por tipo y URL, con el ciclo de vida de los
-- hallazgos (estado y notas no se pisan al volver a rastrear; se resuelve sola
-- cuando desaparece y vuelve si reaparece).
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_crawl_issues" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- sha1 del tipo y la URL normalizada.
  "key" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  -- high · medium · low
  "severity" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "url_key" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "data" JSONB NOT NULL DEFAULT '{}',
  -- new · reviewed · fixed · ok
  "status" TEXT NOT NULL DEFAULT 'new',
  "notes" TEXT,
  -- Sigue en el último rastreo.
  "active" BOOLEAN NOT NULL DEFAULT true,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  -- Se dio por arreglada (o desapareció) y ha vuelto a salir.
  "returned_at" TIMESTAMPTZ(6),
  "first_crawl_id" UUID,
  "last_crawl_id" UUID,
  -- Rastreo en que apareció por última vez (o volvió) y en el que se resolvió.
  "appeared_crawl_id" UUID,
  "resolved_crawl_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_crawl_issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_crawl_issues_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_crawl_issues_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_crawl_issues_key" ON "seo_crawl_issues" ("project_id", "key");
CREATE INDEX "seo_crawl_issues_open_idx" ON "seo_crawl_issues" ("project_id", "active", "severity");
CREATE INDEX "seo_crawl_issues_url_idx" ON "seo_crawl_issues" ("project_id", "url_key");
CREATE INDEX "seo_crawl_issues_tenant_idx" ON "seo_crawl_issues" ("tenant_id");

ALTER TABLE "seo_crawl_issues" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_crawl_issues" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
