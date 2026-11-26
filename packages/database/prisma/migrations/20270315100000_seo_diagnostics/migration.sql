-- SEO Avanzado, PR 5: diagnóstico (§18.4, §18.5, §18.7, §19.2 y §19.5).
--
-- Canibalización y páginas que no deberían estar en Google, cada una en su
-- tabla. No van como tipos nuevos de `seo_opportunities` porque su forma es
-- otra (varias páginas con su reparto y la página ganadora de cada día;
-- gravedad en vez de puntuación; categoría y regla), se recalculan con sus
-- propios umbrales y no deben mezclarse con la lista ordenada por puntuación.
-- El ciclo de vida sí es el de las oportunidades: clave estable, recalcular
-- no pisa estado ni notas, lo que deja de salir queda inactivo y lo que se dio
-- por arreglado vuelve como nuevo si Google lo sigue enseñando después.
--
-- Las palabras seguidas no necesitan tabla: su evolución sale de
-- `seo_gsc_metrics` (cruces `query`, `query_page`, `query_device` y
-- `query_country`) y su catálogo es `seo_project_keywords`.
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

-- Umbrales de canibalización y reglas de indexación del proyecto (vacío = los
-- de por defecto) y fecha del último cálculo.
ALTER TABLE "seo_projects"
  ADD COLUMN "diagnostic_settings" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "diagnostics_calculated_at" TIMESTAMPTZ(6);

CREATE TABLE "seo_cannibalizations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  "domain" TEXT NOT NULL,
  -- Resumen (sha1) de dominio + búsqueda.
  "key" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  -- high · medium · low
  "severity" TEXT NOT NULL,
  -- conflict · switch · split · coexistence
  "kind" TEXT NOT NULL,
  -- URL objetivo + portada con poca parte (gravedad baja).
  "expected" BOOLEAN NOT NULL DEFAULT false,
  -- Páginas con su reparto de impresiones, clics y posición.
  "pages" JSONB NOT NULL DEFAULT '[]',
  -- La página que más salió cada día del periodo.
  "timeline" JSONB NOT NULL DEFAULT '[]',
  "switches" INTEGER NOT NULL DEFAULT 0,
  "target_url" TEXT,
  "suggested_url" TEXT,
  "totals" JSONB NOT NULL DEFAULT '{}',
  "period_from" DATE NOT NULL,
  "period_to" DATE NOT NULL,
  -- Último día en que salieron dos o más páginas (para «ha vuelto»).
  "last_data_date" DATE,
  "reason" TEXT NOT NULL DEFAULT '',
  "action" TEXT NOT NULL DEFAULT '',
  -- new · reviewed · fixed · ok
  "status" TEXT NOT NULL DEFAULT 'new',
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "returned_at" TIMESTAMPTZ(6),
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_cannibalizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_cannibalizations_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_cannibalizations_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_cannibalizations_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_cannibalizations_project_key_key"
  ON "seo_cannibalizations" ("project_id", "key");
CREATE INDEX "seo_cannibalizations_list_idx"
  ON "seo_cannibalizations" ("project_id", "status", "severity");
CREATE INDEX "seo_cannibalizations_tenant_idx" ON "seo_cannibalizations" ("tenant_id");

ALTER TABLE "seo_cannibalizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_cannibalizations" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "seo_index_findings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  "domain" TEXT NOT NULL,
  -- Resumen (sha1) de dominio + URL + categoría.
  "key" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  -- login · private · technical · params · demo · duplicate · redirect_domain · custom
  "category" TEXT NOT NULL,
  "rule" TEXT NOT NULL,
  -- Siempre «aparece en el rendimiento de Search Console» (la indexación
  -- confirmada llega con la inspección de URL, en otra fase).
  "evidence" TEXT NOT NULL DEFAULT 'performance',
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  -- Primer y último día con impresiones (fechas de Google).
  "first_date" DATE NOT NULL,
  "last_date" DATE NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "action" TEXT NOT NULL DEFAULT '',
  -- new · reviewed · fixed · ok
  "status" TEXT NOT NULL DEFAULT 'new',
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "returned_at" TIMESTAMPTZ(6),
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_index_findings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_index_findings_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_index_findings_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_index_findings_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_index_findings_project_key_key"
  ON "seo_index_findings" ("project_id", "key");
CREATE INDEX "seo_index_findings_list_idx"
  ON "seo_index_findings" ("project_id", "status", "category");
CREATE INDEX "seo_index_findings_tenant_idx" ON "seo_index_findings" ("tenant_id");

ALTER TABLE "seo_index_findings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_index_findings" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- Para la evolución de las palabras seguidas: lo de una búsqueda en un
-- dominio y periodo (cruces `query`, `query_page`, `query_device` y
-- `query_country`).
CREATE INDEX "seo_gsc_metrics_domain_grain_query_date_idx"
  ON "seo_gsc_metrics" ("domain_id", "grain", "query", "date");
