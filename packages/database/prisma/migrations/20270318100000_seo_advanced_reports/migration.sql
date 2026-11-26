-- SEO Avanzado, PR 8 (fase 3): lo que trae Google (§18.9), alertas e
-- informes semanal y mensual (§7, §8 y §12).
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

-- ---------------------------------------------------------------------------
-- Página de entrada y origen de las conversiones (atribución que ya existía,
-- con lo mínimo que faltaba para contarlas).
-- ---------------------------------------------------------------------------

-- Primera página que vio el visitante del contacto (o de su reserva).
ALTER TABLE "leads" ADD COLUMN "landing_path" TEXT;

-- La lista de espera de la web no guardaba de dónde venía el visitante.
ALTER TABLE "waitlist_entries"
  ADD COLUMN "utm_source" TEXT,
  ADD COLUMN "utm_medium" TEXT,
  ADD COLUMN "utm_campaign" TEXT,
  ADD COLUMN "landing_path" TEXT;

-- El formulario de trasteros.pro: qué se pidió (contacto, demo o calculadora),
-- de dónde vino y por qué página entró (antes solo llegaba al lead del admin).
ALTER TABLE "platform_contact_messages"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'contact',
  ADD COLUMN "utm_source" TEXT,
  ADD COLUMN "utm_medium" TEXT,
  ADD COLUMN "utm_campaign" TEXT,
  ADD COLUMN "landing_path" TEXT;

-- El alta de un tenant desde la web: de dónde vino y por qué página entró.
-- (Su lead del admin guarda el primer origen del contacto, que puede ser otro.)
ALTER TABLE "tenants"
  ADD COLUMN "signup_utm_source" TEXT,
  ADD COLUMN "signup_utm_medium" TEXT,
  ADD COLUMN "signup_utm_campaign" TEXT,
  ADD COLUMN "signup_landing_path" TEXT;

-- ---------------------------------------------------------------------------
-- Ajustes del proyecto: alertas, informes y conversiones.
-- ---------------------------------------------------------------------------

ALTER TABLE "seo_projects"
  -- Umbrales, reglas apagadas y correo de las alertas (vacío = por defecto).
  ADD COLUMN "alert_settings" JSONB NOT NULL DEFAULT '{}',
  -- Informes: semanal, mensual, destinatarios y correos de fuera.
  ADD COLUMN "report_settings" JSONB NOT NULL DEFAULT '{}',
  -- Proyecto de la plataforma que cuenta las conversiones de trasteros.pro
  -- (null = se decide por el dominio: el de la web de la plataforma).
  ADD COLUMN "platform_conversions" BOOLEAN,
  ADD COLUMN "conversions_calculated_at" TIMESTAMPTZ(6),
  ADD COLUMN "alerts_checked_at" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- Conversiones del tráfico orgánico por día, tipo y página de entrada.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_conversions_daily" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- El dominio principal del proyecto (la atribución no sabe por cuál entró).
  "domain_id" UUID,
  -- Día en hora de España.
  "date" DATE NOT NULL,
  -- booking_started · booking_signed · booking_paid · contact · waitlist ·
  -- demo_request · signup · paid_signup
  "type" TEXT NOT NULL,
  -- Ruta de la página de entrada ('' = no se sabe).
  "landing_path" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 0,
  -- Ingresos del primer pago (solo en los pagos).
  "revenue" DECIMAL(12, 2),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_conversions_daily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_conversions_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_conversions_daily_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_conversions_daily_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_conversions_daily_key" ON "seo_conversions_daily"
  ("project_id", "date", "type", "landing_path");
CREATE INDEX "seo_conversions_daily_tenant_idx" ON "seo_conversions_daily" ("tenant_id");

ALTER TABLE "seo_conversions_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_conversions_daily" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Alertas del proyecto.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_alerts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- clicks_drop · position_drop · gsc_stale · gsc_access_lost · private_page ·
  -- cannibalization · sistrix_reconnect · sistrix_quota
  "type" TEXT NOT NULL,
  -- Clave de deduplicación: una alerta no se repite mientras siga abierta.
  "dedup_key" TEXT NOT NULL,
  -- high · medium · low
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL DEFAULT '',
  "data" JSONB NOT NULL DEFAULT '{}',
  -- open · silenced · resolved
  "status" TEXT NOT NULL DEFAULT 'open',
  "silenced_until" TIMESTAMPTZ(6),
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  -- auto (la condición desapareció) · manual
  "resolved_by" TEXT,
  "notified_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_alerts_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Una sola alerta viva (abierta o silenciada) por clave: entre réplicas tampoco se duplica.
CREATE UNIQUE INDEX "seo_alerts_live_key" ON "seo_alerts" ("project_id", "dedup_key")
  WHERE "status" <> 'resolved';
CREATE INDEX "seo_alerts_list_idx" ON "seo_alerts" ("project_id", "status", "last_seen_at" DESC);
CREATE INDEX "seo_alerts_tenant_idx" ON "seo_alerts" ("tenant_id");

ALTER TABLE "seo_alerts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_alerts" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Informes enviados.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_reports" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  -- weekly · monthly
  "kind" TEXT NOT NULL,
  "period_from" DATE NOT NULL,
  "period_to" DATE NOT NULL,
  -- 2026-W47 · 2026-10
  "period_key" TEXT NOT NULL,
  -- cron · manual
  "trigger" TEXT NOT NULL DEFAULT 'cron',
  -- sent · empty · failed
  "status" TEXT NOT NULL DEFAULT 'sent',
  "recipients" TEXT[] NOT NULL DEFAULT '{}',
  -- El PDF en el bucket privado `reports`.
  "pdf_key" TEXT,
  "error" TEXT,
  "requested_by_user_id" UUID,
  "requested_by_super_admin_id" UUID,
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_reports_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_reports_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_reports_requested_by_super_admin_id_fkey" FOREIGN KEY ("requested_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- El cron envía cada informe una sola vez por proyecto y periodo (también con varias réplicas).
CREATE UNIQUE INDEX "seo_reports_cron_key" ON "seo_reports" ("project_id", "kind", "period_key")
  WHERE "trigger" = 'cron';
CREATE INDEX "seo_reports_list_idx" ON "seo_reports" ("project_id", "created_at" DESC);
CREATE INDEX "seo_reports_tenant_idx" ON "seo_reports" ("tenant_id");

ALTER TABLE "seo_reports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_reports" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
