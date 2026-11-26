-- SEO Avanzado, PR 3: SISTRIX (MCP como principal y API clásica preparada) con
-- una arquitectura de proveedores.
--
-- «Fondo» de datos: lo que se descarga de SISTRIX se guarda con el `tenant_id`
-- del dueño de la conexión con la que se pidió. Vacío = la conexión de la
-- plataforma (trasteros.pro y los proyectos de tenant que el super admin marca
-- con «Usar la conexión de SISTRIX de la plataforma»); con valor = la clave de
-- API propia de ese tenant. Así los datos pedidos con la cuenta de la
-- plataforma no llegan a otros tenants (las condiciones de SISTRIX prohíben
-- cederlos) y dos proyectos del mismo fondo comparten caché y datos.

-- Uso de la conexión de la plataforma en un proyecto de tenant (solo superadmin).
ALTER TABLE "seo_projects"
  ADD COLUMN "use_platform_sistrix" BOOLEAN NOT NULL DEFAULT false;

-- Las tandas de SISTRIX van en `seo_sync_runs` (provider sistrix_mcp/api).
ALTER TABLE "seo_sync_runs"
  -- visibility · domain_keywords · competitors · serp · keyword_metrics ·
  -- opportunities · backlinks · ai_visibility · keyword_ideas (null = Search Console)
  ADD COLUMN "data_type" TEXT,
  -- Lista de lo que hay que pedir y por dónde va (para reanudar).
  ADD COLUMN "progress" JSONB,
  ADD COLUMN "items_total" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_done" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_failed" INTEGER NOT NULL DEFAULT 0,
  -- Por qué está en espera (cuota del MCP, presupuesto de la API…) y hasta cuándo.
  ADD COLUMN "paused_reason" TEXT,
  ADD COLUMN "paused_until" TIMESTAMPTZ(6),
  ADD COLUMN "credits_used" INTEGER NOT NULL DEFAULT 0;
-- Una tanda de SISTRIX viva por proyecto y tipo de dato.
CREATE UNIQUE INDEX "seo_sync_runs_sistrix_active_key" ON "seo_sync_runs" ("project_id", "data_type")
  WHERE "data_type" IS NOT NULL AND "status" IN ('queued', 'running', 'waiting');
CREATE INDEX "seo_sync_runs_data_type_idx" ON "seo_sync_runs" ("project_id", "data_type", "finished_at" DESC)
  WHERE "data_type" IS NOT NULL;

-- Conexiones con los proveedores de pago: el MCP y la API de la plataforma
-- (`tenant_id` vacío) y la clave de API de cada tenant. Los secretos, cifrados.
CREATE TABLE "seo_provider_connections" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  -- sistrix_mcp · sistrix_api
  "provider" TEXT NOT NULL,
  -- disconnected · connected · needs_reauth · error
  "status" TEXT NOT NULL DEFAULT 'disconnected',
  -- La API se activa a mano (la de la plataforma, desactivada por defecto).
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  -- MCP: cliente registrado (client_id/secret, JSON cifrado) y dirección de vuelta.
  "client_info_encrypted" TEXT,
  "redirect_uri" TEXT,
  -- MCP: servidor de autorización descubierto, sus metadatos y el `resource`.
  "oauth_metadata" JSONB,
  "access_token_encrypted" TEXT,
  "refresh_token_encrypted" TEXT,
  "token_expires_at" TIMESTAMPTZ(6),
  "scope" TEXT,
  -- API clásica: la clave (cifrada) y sus 4 últimas letras.
  "api_key_encrypted" TEXT,
  "api_key_last4" TEXT,
  -- Herramientas del MCP (`tools/list`): nombre, descripción, esquema y huella.
  "tools" JSONB,
  "tools_hash" TEXT,
  "tools_checked_at" TIMESTAMPTZ(6),
  "tools_changed_at" TIMESTAMPTZ(6),
  "tools_changes" JSONB,
  -- MCP: cuota diaria agotada (error 7010) hasta esta hora.
  "quota_exhausted_until" TIMESTAMPTZ(6),
  "quota_notified_at" TIMESTAMPTZ(6),
  -- API de la plataforma: «Continuar por API» autorizado hasta esta hora.
  "api_authorized_until" TIMESTAMPTZ(6),
  "api_authorized_by_super_admin_id" UUID,
  -- Presupuesto semanal de créditos (semana de lunes 00:00, hora de Madrid).
  "weekly_budget" INTEGER NOT NULL DEFAULT 0,
  "week_start" DATE,
  "week_spent" INTEGER NOT NULL DEFAULT 0,
  "credits_balance" INTEGER,
  "credits_checked_at" TIMESTAMPTZ(6),
  "last_success_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "last_error_at" TIMESTAMPTZ(6),
  "connected_at" TIMESTAMPTZ(6),
  "connected_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_provider_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_provider_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_provider_connections_owner_key" ON "seo_provider_connections" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid), "provider"
);
CREATE INDEX "seo_provider_connections_tenant_idx" ON "seo_provider_connections" ("tenant_id");

-- Estado de la autorización OAuth del MCP: un solo uso, 10 minutos, ligado al
-- super admin que la empezó. Tabla global (solo la conexión de administración).
CREATE TABLE "seo_oauth_states" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "state_hash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "super_admin_id" UUID NOT NULL,
  "code_verifier_encrypted" TEXT NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_oauth_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_oauth_states_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_oauth_states_state_hash_key" ON "seo_oauth_states" ("state_hash");
REVOKE ALL ON "seo_oauth_states" FROM storageos_app;

-- Frecuencia de cada tipo de dato y límites internos de un fondo.
CREATE TABLE "seo_sync_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "frequencies" JSONB NOT NULL DEFAULT '{}',
  "max_requests_per_day" INTEGER NOT NULL DEFAULT 300,
  "max_requests_per_batch" INTEGER NOT NULL DEFAULT 60,
  -- Pausa entre dos llamadas (milisegundos).
  "pause_ms" INTEGER NOT NULL DEFAULT 1000,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_sync_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_sync_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_sync_settings_owner_key" ON "seo_sync_settings" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid)
);

-- Competidores de un proyecto. Los descubiertos por SISTRIX entran inactivos
-- (sugerencias); solo cuentan para el límite los activos.
CREATE TABLE "seo_competitors" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "name" TEXT,
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  -- manual · discovered
  "source" TEXT NOT NULL DEFAULT 'manual',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_competitors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_competitors_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_competitors_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_competitors_project_domain_key" ON "seo_competitors" ("project_id", "domain");
CREATE INDEX "seo_competitors_tenant_idx" ON "seo_competitors" ("tenant_id");

-- Diccionario global de palabras (texto normalizado, país e idioma). Sin datos
-- de nadie: las métricas van aparte, por fondo.
CREATE TABLE "seo_keywords" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "keyword" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_keywords_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seo_keywords_keyword_country_language_key"
  ON "seo_keywords" ("keyword", "country", "language");
REVOKE ALL ON "seo_keywords" FROM storageos_app;

-- Palabras de un proyecto. `strategy_locked`: una decisión manual que una
-- importación posterior no debe pisar.
CREATE TABLE "seo_project_keywords" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "keyword_id" UUID NOT NULL,
  "group_name" TEXT,
  -- know · do · visit · website (la manual; la de SISTRIX va en las métricas)
  "intent" TEXT,
  "target_url" TEXT,
  -- 1 alta · 2 media · 3 baja
  "priority" INTEGER NOT NULL DEFAULT 2,
  "notes" TEXT,
  "strategy_locked" BOOLEAN NOT NULL DEFAULT false,
  -- manual · sistrix_ideas · sistrix_opportunities · import
  "source" TEXT NOT NULL DEFAULT 'manual',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_project_keywords_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_project_keywords_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_project_keywords_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_project_keywords_keyword_id_fkey" FOREIGN KEY ("keyword_id")
    REFERENCES "seo_keywords" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_project_keywords_project_keyword_key"
  ON "seo_project_keywords" ("project_id", "keyword_id");
CREATE INDEX "seo_project_keywords_tenant_idx" ON "seo_project_keywords" ("tenant_id");

-- Métricas de una palabra (histórico: cada observación es una fila nueva).
CREATE TABLE "seo_keyword_metrics" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "keyword_id" UUID NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "data_date" DATE,
  -- Volumen estimado de SISTRIX («traffic») y clics.
  "traffic" INTEGER,
  "clicks" INTEGER,
  "cpc" DECIMAL(10,2),
  "competition" INTEGER,
  "intent_know" INTEGER,
  "intent_do" INTEGER,
  "intent_visit" INTEGER,
  "intent_website" INTEGER,
  "mobile_share" DECIMAL(5,4),
  "desktop_share" DECIMAL(5,4),
  "questions" JSONB,
  CONSTRAINT "seo_keyword_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_keyword_metrics_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_keyword_metrics_keyword_id_fkey" FOREIGN KEY ("keyword_id")
    REFERENCES "seo_keywords" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "seo_keyword_metrics_lookup_idx"
  ON "seo_keyword_metrics" ("keyword_id", "country", "fetched_at" DESC);
CREATE INDEX "seo_keyword_metrics_tenant_idx" ON "seo_keyword_metrics" ("tenant_id");

-- Métricas de un dominio por fecha del dato: visibilidad (semanal o diaria),
-- nº de palabras, palabras en el top 10…
CREATE TABLE "seo_domain_metrics" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "domain" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  -- visibility · keyword_count · top10_count
  "metric" TEXT NOT NULL,
  -- weekly · daily
  "granularity" TEXT NOT NULL DEFAULT 'weekly',
  "metric_date" DATE NOT NULL,
  "value" DECIMAL(16,4) NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_domain_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_domain_metrics_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_domain_metrics_key" ON "seo_domain_metrics" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "domain", "country", "provider", "metric", "granularity", "metric_date"
);
CREATE INDEX "seo_domain_metrics_lookup_idx"
  ON "seo_domain_metrics" ("domain", "country", "metric", "metric_date");
CREATE INDEX "seo_domain_metrics_tenant_idx" ON "seo_domain_metrics" ("tenant_id");

-- Palabras de un dominio (propio o competidor) en una fecha de muestra.
CREATE TABLE "seo_domain_keywords" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "domain" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "keyword" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "url" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "seo_domain_keywords_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_domain_keywords_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_domain_keywords_key" ON "seo_domain_keywords" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "domain", "country", "provider", "sample_date", md5("keyword")
);
CREATE INDEX "seo_domain_keywords_lookup_idx"
  ON "seo_domain_keywords" ("domain", "country", "sample_date" DESC);
CREATE INDEX "seo_domain_keywords_tenant_idx" ON "seo_domain_keywords" ("tenant_id");

-- Primeros resultados de Google de una palabra en una fecha.
CREATE TABLE "seo_serp_results" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "keyword_id" UUID NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "position" INTEGER NOT NULL,
  "domain" TEXT NOT NULL,
  "url" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "seo_serp_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_serp_results_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_serp_results_keyword_id_fkey" FOREIGN KEY ("keyword_id")
    REFERENCES "seo_keywords" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_serp_results_key" ON "seo_serp_results" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "keyword_id", "country", "provider", "sample_date", "position"
);
CREATE INDEX "seo_serp_results_lookup_idx"
  ON "seo_serp_results" ("keyword_id", "country", "sample_date" DESC);
CREATE INDEX "seo_serp_results_tenant_idx" ON "seo_serp_results" ("tenant_id");

-- Oportunidades (vista `opportunities`) e ideas (vista `ideas`) de un dominio.
CREATE TABLE "seo_domain_opportunities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "domain" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  -- opportunity · idea
  "kind" TEXT NOT NULL DEFAULT 'opportunity',
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "keyword" TEXT NOT NULL,
  "position" INTEGER,
  "url" TEXT,
  "gain" INTEGER,
  "competition" INTEGER,
  "traffic" INTEGER,
  CONSTRAINT "seo_domain_opportunities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_domain_opportunities_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_domain_opportunities_key" ON "seo_domain_opportunities" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "domain", "country", "provider", "kind", "sample_date", md5("keyword")
);
CREATE INDEX "seo_domain_opportunities_lookup_idx"
  ON "seo_domain_opportunities" ("domain", "country", "kind", "sample_date" DESC);
CREATE INDEX "seo_domain_opportunities_tenant_idx" ON "seo_domain_opportunities" ("tenant_id");

-- Páginas más enlazadas de un dominio (vista `linktargets`).
CREATE TABLE "seo_backlink_targets" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "domain" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "url" TEXT NOT NULL,
  "links" INTEGER NOT NULL DEFAULT 0,
  "domains" INTEGER NOT NULL DEFAULT 0,
  "hosts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "seo_backlink_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_backlink_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_backlink_targets_key" ON "seo_backlink_targets" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "domain", "provider", "sample_date", md5("url")
);
CREATE INDEX "seo_backlink_targets_lookup_idx"
  ON "seo_backlink_targets" ("domain", "sample_date" DESC);
CREATE INDEX "seo_backlink_targets_tenant_idx" ON "seo_backlink_targets" ("tenant_id");

-- Visibilidad en buscadores de IA (`ai_check`, vista `overview`).
CREATE TABLE "seo_ai_visibility" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "domain" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sample_date" DATE NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "prompt_count" INTEGER NOT NULL DEFAULT 0,
  -- [{ model, promptCount }]
  "models" JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "seo_ai_visibility_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ai_visibility_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_ai_visibility_key" ON "seo_ai_visibility" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "domain", "country", "provider", "sample_date"
);
CREATE INDEX "seo_ai_visibility_tenant_idx" ON "seo_ai_visibility" ("tenant_id");

-- Cada petición a un proveedor de pago (sin secretos en los argumentos).
CREATE TABLE "seo_api_requests" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID,
  "run_id" UUID,
  "provider" TEXT NOT NULL,
  -- Herramienta del MCP o método de la API.
  "tool" TEXT NOT NULL,
  "view" TEXT,
  "args" JSONB NOT NULL DEFAULT '{}',
  "query_hash" TEXT NOT NULL,
  -- ok · empty · error · quota · cached
  "status" TEXT NOT NULL,
  "error_code" TEXT,
  "error_message" TEXT,
  "duration_ms" INTEGER NOT NULL DEFAULT 0,
  "credits" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_api_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_api_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_api_requests_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_api_requests_run_id_fkey" FOREIGN KEY ("run_id")
    REFERENCES "seo_sync_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_api_requests_tenant_created_idx" ON "seo_api_requests" ("tenant_id", "created_at" DESC);
CREATE INDEX "seo_api_requests_created_idx" ON "seo_api_requests" ("created_at");
CREATE INDEX "seo_api_requests_query_hash_idx" ON "seo_api_requests" ("query_hash");

-- Respuesta normalizada por huella de la consulta, con caducidad según el tipo
-- de dato: dos proyectos del mismo fondo que piden lo mismo hacen una consulta.
CREATE TABLE "seo_api_cache" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "query_hash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "tool" TEXT NOT NULL,
  "view" TEXT,
  "data" JSONB NOT NULL,
  "data_date" DATE,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "seo_api_cache_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_api_cache_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_api_cache_key" ON "seo_api_cache" (
  COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid), "query_hash"
);
CREATE INDEX "seo_api_cache_expires_idx" ON "seo_api_cache" ("expires_at");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'seo_provider_connections', 'seo_sync_settings', 'seo_competitors',
    'seo_project_keywords', 'seo_keyword_metrics', 'seo_domain_metrics',
    'seo_domain_keywords', 'seo_serp_results', 'seo_domain_opportunities',
    'seo_backlink_targets', 'seo_ai_visibility', 'seo_api_requests', 'seo_api_cache'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO storageos_app '
      'USING ("tenant_id" = current_setting(''app.current_tenant'', true)::uuid) '
      'WITH CHECK ("tenant_id" = current_setting(''app.current_tenant'', true)::uuid)',
      t
    );
  END LOOP;
END $$;
