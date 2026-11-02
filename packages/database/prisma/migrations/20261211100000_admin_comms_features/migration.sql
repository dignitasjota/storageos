-- Comunicación del panel admin: mejoras (PR B).

-- 1. Historial de anuncios (borrador, programado, enviado…).
CREATE TABLE "platform_announcements" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  -- Público: {audience, tenantIds, tag, plans, addons, missingAddons, health, inactiveDays, minFacilities, maxFacilities}
  "segment" JSONB NOT NULL DEFAULT '{}',
  "commercial" BOOLEAN NOT NULL DEFAULT false,
  -- draft | scheduled | sending | sent | cancelled
  "status" TEXT NOT NULL DEFAULT 'draft',
  "scheduled_for" TIMESTAMPTZ(6),
  "sent_at" TIMESTAMPTZ(6),
  "tenants_count" INTEGER NOT NULL DEFAULT 0,
  "recipients_count" INTEGER NOT NULL DEFAULT 0,
  "opted_out_count" INTEGER NOT NULL DEFAULT 0,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_announcements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_announcements_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_announcements_status_idx" ON "platform_announcements" ("status", "scheduled_for");
REVOKE ALL ON "platform_announcements" FROM storageos_app;

-- Cada correo enviado sabe de qué anuncio es, y se guarda su HTML (salvo los de cuenta).
ALTER TABLE "platform_email_logs" ADD COLUMN "announcement_id" UUID;
ALTER TABLE "platform_email_logs" ADD COLUMN "body_html" TEXT;
ALTER TABLE "platform_email_logs"
  ADD CONSTRAINT "platform_email_logs_announcement_id_fkey" FOREIGN KEY ("announcement_id")
  REFERENCES "platform_announcements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "platform_email_logs_announcement_id_idx" ON "platform_email_logs" ("announcement_id");
CREATE INDEX "platform_email_logs_recipient_status_idx" ON "platform_email_logs" ("recipient", "status");

-- 2. Novedades con captura y destacadas.
ALTER TABLE "product_updates" ADD COLUMN "image_key" TEXT;
ALTER TABLE "product_updates" ADD COLUMN "highlighted" BOOLEAN NOT NULL DEFAULT false;

-- 3. Varios banners, con inicio, público, enlace y prioridad.
CREATE TABLE "platform_banners" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "message" TEXT NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'info',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "starts_at" TIMESTAMPTZ(6),
  "ends_at" TIMESTAMPTZ(6),
  "dismissible" BOOLEAN NOT NULL DEFAULT true,
  "link_url" TEXT,
  "link_label" TEXT,
  -- Vacío = todos.
  "plans" TEXT[] NOT NULL DEFAULT '{}',
  "statuses" TEXT[] NOT NULL DEFAULT '{}',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_banners_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_banners" FROM storageos_app;
INSERT INTO "platform_banners" ("message", "level", "enabled", "ends_at", "dismissible", "updated_at")
SELECT "message", "level", "enabled", "ends_at", "dismissible", "updated_at"
FROM "platform_banner"
WHERE btrim("message") <> '';
DROP TABLE "platform_banner";

-- 4. Mensajes de TrasterOS sin respuesta necesaria y con adjuntos.
ALTER TABLE "tenant_platform_messages" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';

-- 5. Textos editables de los correos automáticos a los tenants (sin fila = el de serie).
CREATE TABLE "platform_email_templates" (
  "code" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_email_templates_pkey" PRIMARY KEY ("code")
);
REVOKE ALL ON "platform_email_templates" FROM storageos_app;

-- 6. Encuestas de satisfacción (NPS) a los tenants.
CREATE TABLE "platform_nps_surveys" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "name" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "segment" JSONB NOT NULL DEFAULT '{}',
  -- draft | sent | closed
  "status" TEXT NOT NULL DEFAULT 'draft',
  "sent_at" TIMESTAMPTZ(6),
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_nps_surveys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_nps_surveys_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
REVOKE ALL ON "platform_nps_surveys" FROM storageos_app;

CREATE TABLE "platform_nps_responses" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "survey_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID,
  "email" TEXT NOT NULL,
  "score" INTEGER,
  "comment" TEXT,
  "responded_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_nps_responses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_nps_responses_survey_id_fkey" FOREIGN KEY ("survey_id")
    REFERENCES "platform_nps_surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_nps_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_nps_responses_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "platform_nps_responses_score_check" CHECK ("score" IS NULL OR ("score" BETWEEN 0 AND 10))
);
CREATE UNIQUE INDEX "platform_nps_responses_survey_user_key" ON "platform_nps_responses" ("survey_id", "user_id");
CREATE INDEX "platform_nps_responses_tenant_idx" ON "platform_nps_responses" ("tenant_id");
REVOKE ALL ON "platform_nps_responses" FROM storageos_app;
