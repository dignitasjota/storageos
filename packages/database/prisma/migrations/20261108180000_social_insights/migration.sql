-- Instagram y Facebook orgánico del tenant (dentro de Web Premium). El tenant
-- pega un token de su Business Manager; cada día se guardan las métricas de
-- su página y de la cuenta de Instagram vinculada, y sus publicaciones.
CREATE TABLE "tenant_social_accounts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "page_id" TEXT NOT NULL,
  "page_name" TEXT NOT NULL,
  -- Cuenta profesional de Instagram vinculada a la página (si la hay).
  "instagram_user_id" TEXT,
  "instagram_username" TEXT,
  -- Token de la página, cifrado (AES-GCM, AAD = tenant).
  "access_token_encrypted" TEXT NOT NULL,
  -- connected | error
  "status" TEXT NOT NULL DEFAULT 'connected',
  "last_error" TEXT,
  "connected_at" TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_social_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_social_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "tenant_social_accounts_tenant_id_key" ON "tenant_social_accounts" ("tenant_id");

-- Una fila por red y día. Las métricas que Meta no devuelve quedan en null.
CREATE TABLE "social_daily_metrics" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  -- instagram | facebook
  "network" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "followers" INTEGER,
  "new_followers" INTEGER,
  "reach" INTEGER,
  "views" INTEGER,
  "profile_views" INTEGER,
  "website_clicks" INTEGER,
  "engagements" INTEGER,
  CONSTRAINT "social_daily_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_daily_metrics_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "social_daily_metrics_key" ON "social_daily_metrics" ("tenant_id", "network", "date");

-- Publicaciones recientes con sus cifras (se actualizan en cada descarga).
CREATE TABLE "social_posts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "network" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL,
  "caption" TEXT,
  "media_type" TEXT,
  "permalink" TEXT,
  "thumbnail_url" TEXT,
  "likes" INTEGER,
  "comments" INTEGER,
  "shares" INTEGER,
  "saves" INTEGER,
  "reach" INTEGER,
  "views" INTEGER,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_posts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "social_posts_key" ON "social_posts" ("tenant_id", "network", "external_id");
CREATE INDEX "social_posts_tenant_published_idx" ON "social_posts" ("tenant_id", "published_at");

ALTER TABLE "tenant_social_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_social_accounts" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "social_daily_metrics" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "social_daily_metrics" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "social_posts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "social_posts" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
