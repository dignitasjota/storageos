-- Mejoras de Marketing (PR 3).

-- Contactos: el canal con el que llegaron (renombrar el origen de un canal ya
-- no les cambia el canal) y los identificadores de clic de los anuncios
-- (`gclid`, `fbclid`), para devolver la conversión a Google Ads o a Meta.
ALTER TABLE "leads"
  ADD COLUMN "marketing_channel_id" UUID,
  ADD COLUMN "click_ids" JSONB;
ALTER TABLE "leads" ADD CONSTRAINT "leads_marketing_channel_id_fkey"
  FOREIGN KEY ("marketing_channel_id") REFERENCES "marketing_channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "leads_tenant_channel_idx" ON "leads"("tenant_id", "marketing_channel_id");

-- Canales: cupón (los contratos con él cuentan para el canal), presupuesto del
-- mes y avisos ya enviados (presupuesto superado, gasto sin reservas a mitad de mes).
ALTER TABLE "marketing_channels"
  ADD COLUMN "coupon_id" UUID,
  ADD COLUMN "monthly_budget" DECIMAL(10, 2),
  ADD COLUMN "budget_notified_month" TEXT,
  ADD COLUMN "midmonth_notified_month" TEXT;
ALTER TABLE "marketing_channels" ADD CONSTRAINT "marketing_channels_coupon_id_fkey"
  FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Conversiones devueltas a las plataformas de anuncios.
ALTER TABLE "google_ads_settings" ADD COLUMN "conversion_action_id" TEXT;
ALTER TABLE "meta_ads_settings" ADD COLUMN "pixel_id" TEXT;

CREATE TABLE "ad_conversion_uploads" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "value" DECIMAL(10, 2),
  "error" TEXT,
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ad_conversion_uploads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ad_conversion_uploads_contract_platform_key"
  ON "ad_conversion_uploads"("contract_id", "platform");
CREATE INDEX "ad_conversion_uploads_tenant_idx" ON "ad_conversion_uploads"("tenant_id", "created_at");
ALTER TABLE "ad_conversion_uploads" ADD CONSTRAINT "ad_conversion_uploads_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ad_conversion_uploads" ADD CONSTRAINT "ad_conversion_uploads_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ad_conversion_uploads" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ad_conversion_uploads";
CREATE POLICY tenant_isolation ON "ad_conversion_uploads" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Visitas de la web: el local y el tamaño que se miran al empezar una reserva.
ALTER TABLE "web_events"
  ADD COLUMN "facility_id" UUID,
  ADD COLUMN "unit_type_id" UUID;

-- Visitas ya sumadas: un registro por visitante, día (en la zona del negocio)
-- y origen, y uno por página y día. Los informes las leen en vez de recorrer
-- todos los eventos.
CREATE TABLE "web_visits" (
  "tenant_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "visitor_id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT '',
  "medium" TEXT NOT NULL DEFAULT '',
  "campaign" TEXT NOT NULL DEFAULT '',
  "device" TEXT,
  "entry_path" TEXT NOT NULL,
  "page_views" INTEGER NOT NULL DEFAULT 0,
  "calls" INTEGER NOT NULL DEFAULT 0,
  "whatsapp" INTEGER NOT NULL DEFAULT 0,
  "emails" INTEGER NOT NULL DEFAULT 0,
  "directions" INTEGER NOT NULL DEFAULT 0,
  "booking_starts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "web_visits_pkey" PRIMARY KEY ("tenant_id", "day", "visitor_id", "source", "medium", "campaign")
);
CREATE INDEX "web_visits_visitor_idx" ON "web_visits"("tenant_id", "visitor_id", "day");
ALTER TABLE "web_visits" ADD CONSTRAINT "web_visits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "web_visits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "web_visits";
CREATE POLICY tenant_isolation ON "web_visits" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "web_page_daily" (
  "tenant_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "path" TEXT NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "visitors" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "web_page_daily_pkey" PRIMARY KEY ("tenant_id", "day", "path")
);
ALTER TABLE "web_page_daily" ADD CONSTRAINT "web_page_daily_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "web_page_daily" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "web_page_daily";
CREATE POLICY tenant_isolation ON "web_page_daily" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Relleno con los eventos que ya había (el día, en la zona de cada negocio).
INSERT INTO "web_visits" (
  "tenant_id", "day", "visitor_id", "source", "medium", "campaign", "device", "entry_path",
  "page_views", "calls", "whatsapp", "emails", "directions", "created_at"
)
SELECT e."tenant_id",
       (e."created_at" AT TIME ZONE COALESCE(t."timezone", 'Europe/Madrid'))::date,
       e."visitor_id",
       COALESCE(e."source", ''),
       COALESCE(e."medium", ''),
       COALESCE(e."campaign", ''),
       (array_agg(e."device" ORDER BY e."created_at") FILTER (WHERE e."device" IS NOT NULL))[1],
       (array_agg(e."path" ORDER BY e."created_at"))[1],
       COUNT(*) FILTER (WHERE e."kind" = 'page_view'),
       COUNT(*) FILTER (WHERE e."kind" = 'call_click'),
       COUNT(*) FILTER (WHERE e."kind" = 'whatsapp_click'),
       COUNT(*) FILTER (WHERE e."kind" = 'email_click'),
       COUNT(*) FILTER (WHERE e."kind" = 'directions_click'),
       MIN(e."created_at")
  FROM "web_events" e
  JOIN "tenants" t ON t."id" = e."tenant_id"
 GROUP BY 1, 2, 3, 4, 5, 6
ON CONFLICT DO NOTHING;

INSERT INTO "web_page_daily" ("tenant_id", "day", "path", "views", "visitors", "clicks")
SELECT e."tenant_id",
       (e."created_at" AT TIME ZONE COALESCE(t."timezone", 'Europe/Madrid'))::date,
       e."path",
       COUNT(*) FILTER (WHERE e."kind" = 'page_view'),
       COUNT(DISTINCT e."visitor_id") FILTER (WHERE e."kind" = 'page_view'),
       COUNT(*) FILTER (WHERE e."kind" <> 'page_view')
  FROM "web_events" e
  JOIN "tenants" t ON t."id" = e."tenant_id"
 GROUP BY 1, 2, 3
ON CONFLICT DO NOTHING;

-- Anotaciones en la gráfica de visitas (una campaña, una promoción, una
-- publicación…), para explicar los picos.
CREATE TABLE "marketing_annotations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "text" TEXT NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "marketing_annotations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "marketing_annotations_tenant_day_idx" ON "marketing_annotations"("tenant_id", "day");
ALTER TABLE "marketing_annotations" ADD CONSTRAINT "marketing_annotations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_annotations" ADD CONSTRAINT "marketing_annotations_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketing_annotations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "marketing_annotations";
CREATE POLICY tenant_isolation ON "marketing_annotations" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Conexión rota: un aviso por fallo (se vuelve a avisar tras arreglarse).
ALTER TABLE "tenant_ga4" ADD COLUMN "error_notified_at" TIMESTAMPTZ(6);
ALTER TABLE "tenant_social_accounts" ADD COLUMN "error_notified_at" TIMESTAMPTZ(6);
ALTER TABLE "tenant_search_console" ADD COLUMN "error_notified_at" TIMESTAMPTZ(6);

-- Publicaciones: clics al enlace (Facebook).
ALTER TABLE "social_posts" ADD COLUMN "link_clicks" INTEGER;

-- Chat de la web: responsable de la conversación y aviso al 80 % del límite del mes.
ALTER TABLE "web_chat_conversations" ADD COLUMN "assigned_to_user_id" UUID;
ALTER TABLE "web_chat_conversations" ADD CONSTRAINT "web_chat_conversations_assigned_to_user_id_fkey"
  FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tenants" ADD COLUMN "web_chat_limit_warned" TEXT;
