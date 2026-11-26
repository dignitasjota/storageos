-- SEO Avanzado, PR 9 (fase 4): inspección de URL de Google (URL Inspection
-- API de Search Console) y PageSpeed Insights (§5, §10, §12 y §19.5).
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

ALTER TABLE "seo_projects"
  -- Tope diario de inspecciones, lote programado y medición semanal de la velocidad.
  ADD COLUMN "technical_settings" JSONB NOT NULL DEFAULT '{}',
  -- Última inspección o medición terminada (para que las alertas se revisen antes).
  ADD COLUMN "technical_updated_at" TIMESTAMPTZ(6),
  -- Último lote semanal de PageSpeed.
  ADD COLUMN "pagespeed_scheduled_at" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- Inspecciones de URL: cada una es una fila (histórico conservado). Las que
-- esperan (en cola o al día siguiente por la cuota) también son filas.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_url_inspections" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  "domain" TEXT NOT NULL,
  -- Propiedad de Search Console a la que se pide (la cuota de Google es por propiedad).
  "gsc_property" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  -- URL normalizada (sin protocolo, www, barra final ni parámetros de seguimiento).
  "url_key" TEXT NOT NULL,
  -- queued · running · done · error
  "status" TEXT NOT NULL DEFAULT 'queued',
  -- manual · batch
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  -- manual · target_high · index_finding · top_clicks
  "reason" TEXT NOT NULL DEFAULT 'manual',
  -- No antes de (cola con pausa, o el día siguiente si se acabó la cuota).
  "scheduled_for" TIMESTAMPTZ(6),
  -- Día de la cuota (hora del Pacífico) en que se gastó la consulta.
  "quota_day" DATE,
  "inspected_at" TIMESTAMPTZ(6),
  "verdict" TEXT,
  "indexed" BOOLEAN,
  "coverage_state" TEXT,
  "robots_txt_state" TEXT,
  "indexing_state" TEXT,
  "page_fetch_state" TEXT,
  "crawled_as" TEXT,
  "last_crawl_at" TIMESTAMPTZ(6),
  "google_canonical" TEXT,
  "user_canonical" TEXT,
  "canonical_mismatch" BOOLEAN NOT NULL DEFAULT false,
  -- Todo lo que devolvió Google (sitemaps, referentes, usabilidad móvil, resultados enriquecidos).
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requested_by_user_id" UUID,
  "requested_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_url_inspections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_url_inspections_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_url_inspections_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_url_inspections_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_url_inspections_url_idx" ON "seo_url_inspections"
  ("project_id", "url_key", "created_at" DESC);
-- Cuota del día por propiedad (y por proyecto).
CREATE INDEX "seo_url_inspections_quota_idx" ON "seo_url_inspections" ("gsc_property", "quota_day");
-- La cola: lo que espera.
CREATE INDEX "seo_url_inspections_queue_idx" ON "seo_url_inspections" ("status", "scheduled_for")
  WHERE "status" IN ('queued', 'running');
-- Una misma URL no espera dos veces en un proyecto.
CREATE UNIQUE INDEX "seo_url_inspections_pending_key" ON "seo_url_inspections"
  ("project_id", "url_key") WHERE "status" IN ('queued', 'running');
CREATE INDEX "seo_url_inspections_tenant_idx" ON "seo_url_inspections" ("tenant_id");

ALTER TABLE "seo_url_inspections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_url_inspections" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Mediciones de PageSpeed Insights por URL y estrategia (histórico conservado).
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_pagespeed_runs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  "url" TEXT NOT NULL,
  "url_key" TEXT NOT NULL,
  -- mobile · desktop
  "strategy" TEXT NOT NULL,
  -- queued · running · done · error
  "status" TEXT NOT NULL DEFAULT 'queued',
  -- manual · batch
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  -- Puntuaciones de Lighthouse (0-100).
  "performance_score" INTEGER,
  "seo_score" INTEGER,
  "accessibility_score" INTEGER,
  "best_practices_score" INTEGER,
  -- Laboratorio (ms; CLS sin unidad).
  "lcp_ms" INTEGER,
  "cls" DOUBLE PRECISION,
  "tbt_ms" INTEGER,
  "fcp_ms" INTEGER,
  "si_ms" INTEGER,
  "tti_ms" INTEGER,
  -- Campo (usuarios reales de Chrome): de la URL o del sitio entero.
  "field_scope" TEXT,
  "field_overall" TEXT,
  "field_lcp_ms" INTEGER,
  "field_inp_ms" INTEGER,
  "field_cls" DOUBLE PRECISION,
  -- Las dos (URL y origen) con sus categorías.
  "field" JSONB NOT NULL DEFAULT '{}',
  -- Principales mejoras sugeridas (título y ahorro estimado).
  "opportunities" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "analyzed_at" TIMESTAMPTZ(6),
  "requested_by_user_id" UUID,
  "requested_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_pagespeed_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_pagespeed_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_pagespeed_runs_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_pagespeed_runs_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_pagespeed_runs_url_idx" ON "seo_pagespeed_runs"
  ("project_id", "url_key", "strategy", "created_at" DESC);
CREATE INDEX "seo_pagespeed_runs_queue_idx" ON "seo_pagespeed_runs" ("status", "created_at")
  WHERE "status" IN ('queued', 'running');
-- Una misma URL y estrategia no espera dos veces en un proyecto.
CREATE UNIQUE INDEX "seo_pagespeed_runs_pending_key" ON "seo_pagespeed_runs"
  ("project_id", "url_key", "strategy") WHERE "status" IN ('queued', 'running');
CREATE INDEX "seo_pagespeed_runs_tenant_idx" ON "seo_pagespeed_runs" ("tenant_id");

ALTER TABLE "seo_pagespeed_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_pagespeed_runs" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- Los hallazgos de indexación que salen de la inspección (canónica distinta,
-- URL objetivo no indexada) llevan `evidence = 'inspection'` y su ciclo de
-- vida lo lleva la inspección, no el recálculo del diagnóstico.
CREATE INDEX "seo_index_findings_evidence_idx" ON "seo_index_findings" ("project_id", "evidence");
