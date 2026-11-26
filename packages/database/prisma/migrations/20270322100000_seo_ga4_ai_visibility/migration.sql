-- SEO Avanzado, PR 12 (fase 5, cierra el plan): Google Analytics del tráfico
-- orgánico por página de entrada y visibilidad en buscadores de IA (ChatGPT,
-- AI Overviews y AI Mode de Google) con SISTRIX.
--
-- `tenant_id` es el del proyecto (nulo = la plataforma) en lo de GA4, y el
-- «fondo» de SISTRIX (el dueño de la conexión) en lo de visibilidad en IA,
-- como el resto de datos de SISTRIX. Política de filas como en el resto.

-- ---------------------------------------------------------------------------
-- Conexión de GA4 de cada proyecto: la propiedad (Data API) y de dónde sale
-- ('own' = puesta aquí; 'marketing' = la que el tenant ya conectó en
-- Marketing, sin pedirla otra vez). Ajustes de la visibilidad en IA: los
-- prompts que se siguen (sus respuestas, con `ai_prompt_answers`).
-- ---------------------------------------------------------------------------

ALTER TABLE "seo_projects"
  ADD COLUMN "ga4_property_id" TEXT,
  ADD COLUMN "ga4_source" TEXT,
  ADD COLUMN "ga4_status" TEXT,
  ADD COLUMN "ga4_last_error" TEXT,
  ADD COLUMN "ga4_connected_at" TIMESTAMPTZ(6),
  ADD COLUMN "ga4_synced_at" TIMESTAMPTZ(6),
  ADD COLUMN "ga4_initial_done_at" TIMESTAMPTZ(6),
  ADD COLUMN "ai_visibility_settings" JSONB NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Tráfico orgánico de Google por página de entrada y día, según GA4
-- (`sessionDefaultChannelGroup = Organic Search` y fuente `google`). La ruta
-- está normalizada como las conversiones (PR 8): se cruza con Search Console
-- y con las conversiones propias por la misma clave.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_ga4_landing_daily" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  -- Host de la página sin `www.` ('' si GA4 no lo da).
  "host" TEXT NOT NULL DEFAULT '',
  "landing_path" TEXT NOT NULL,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  "users" INTEGER NOT NULL DEFAULT 0,
  "engaged_sessions" INTEGER NOT NULL DEFAULT 0,
  -- Suma de la duración de las sesiones (media × sesiones), en segundos.
  "duration_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "page_views" INTEGER NOT NULL DEFAULT 0,
  "key_events" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_ga4_landing_daily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ga4_landing_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ga4_landing_daily_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_ga4_landing_daily_key"
  ON "seo_ga4_landing_daily" ("project_id", "date", "host", "landing_path");
CREATE INDEX "seo_ga4_landing_daily_tenant_idx" ON "seo_ga4_landing_daily" ("tenant_id");

ALTER TABLE "seo_ga4_landing_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_ga4_landing_daily" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Visibilidad en IA (`ai_check`, PR 3): además de los dominios, las marcas.
-- `domain` guarda el dominio o la marca (en minúsculas).
-- ---------------------------------------------------------------------------

ALTER TABLE "seo_ai_visibility" ADD COLUMN "subject_type" TEXT NOT NULL DEFAULT 'domain';
DROP INDEX "seo_ai_visibility_key";
CREATE UNIQUE INDEX "seo_ai_visibility_key" ON "seo_ai_visibility" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "subject_type", "domain", "country", "provider", "sample_date"
);

-- ---------------------------------------------------------------------------
-- Prompts en los que aparece un dominio o una marca (vista `prompts`) y las
-- respuestas de los prompts que se siguen (`ai_prompt_answers`, con
-- `subject_type = 'tracked'`). La respuesta de la IA es texto de terceros: se
-- guarda tal cual y nunca se interpreta (ni HTML ni enlaces).
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_ai_prompts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  -- domain · brand · tracked
  "subject_type" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "prompt" TEXT NOT NULL,
  -- El prompt normalizado (minúsculas, sin espacios de más): cruza dominios y marcas.
  "prompt_key" TEXT NOT NULL,
  -- aio · ai_mode · chatgpt ('' si no se sabe).
  "model" TEXT NOT NULL DEFAULT '',
  "answer" TEXT,
  "rank" INTEGER,
  CONSTRAINT "seo_ai_prompts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ai_prompts_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_ai_prompts_key" ON "seo_ai_prompts" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "subject_type", "subject", "country", "provider", "sample_date", "prompt_key", "model"
);
CREATE INDEX "seo_ai_prompts_subject_idx"
  ON "seo_ai_prompts" ("subject_type", "subject", "country", "sample_date");
CREATE INDEX "seo_ai_prompts_tenant_idx" ON "seo_ai_prompts" ("tenant_id");

ALTER TABLE "seo_ai_prompts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_ai_prompts" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Fuentes que citan las IA (vista `sources`, por dominio o URL) y marcas que
-- compiten (vista `competitors`, `source_type = 'brand'`).
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_ai_sources" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  -- domain · brand
  "subject_type" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- domain · url · brand
  "source_type" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "seo_ai_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ai_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_ai_sources_key" ON "seo_ai_sources" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "subject_type", "subject", "country", "provider", "sample_date", "source_type", "source"
);
CREATE INDEX "seo_ai_sources_tenant_idx" ON "seo_ai_sources" ("tenant_id");

ALTER TABLE "seo_ai_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_ai_sources" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
