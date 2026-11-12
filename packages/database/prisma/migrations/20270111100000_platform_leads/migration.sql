-- Leads del panel admin: quien se interesa por TrasterOS, desde el primer
-- contacto hasta que paga (o se pierde), con su actividad y sus seguimientos.
-- Tablas globales (sin tenant): solo las usa el super admin.

CREATE TABLE "platform_leads" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- new · contacted · interested · trial · customer · lost
  "status" TEXT NOT NULL DEFAULT 'new',
  "source" TEXT NOT NULL DEFAULT 'admin',
  "company_name" TEXT,
  "contact_name" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "units" TEXT,
  "facilities" TEXT,
  "profile" TEXT,
  "current_software" TEXT,
  "city" TEXT,
  "plan_slug" TEXT,
  "message" TEXT,
  "assigned_to_id" UUID,
  "tenant_id" UUID,
  "utm_source" TEXT,
  "utm_medium" TEXT,
  "utm_campaign" TEXT,
  "contacted_at" TIMESTAMPTZ(6),
  "interested_at" TIMESTAMPTZ(6),
  "trial_at" TIMESTAMPTZ(6),
  "customer_at" TIMESTAMPTZ(6),
  "lost_at" TIMESTAMPTZ(6),
  "lost_reason_code" TEXT,
  "lost_reason" TEXT,
  "first_response_at" TIMESTAMPTZ(6),
  "unattended_notified_at" TIMESTAMPTZ(6),
  -- «No es un lead»: sale del tablero y de las cifras.
  "discarded_at" TIMESTAMPTZ(6),
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_leads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_leads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "platform_leads_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "platform_leads_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Un tenant es como mucho de un lead.
CREATE UNIQUE INDEX "platform_leads_tenant_id_key" ON "platform_leads" ("tenant_id");
CREATE INDEX "platform_leads_status_idx" ON "platform_leads" ("status", "created_at" DESC)
  WHERE "discarded_at" IS NULL;
CREATE INDEX "platform_leads_email_idx" ON "platform_leads" (lower("email"))
  WHERE "discarded_at" IS NULL;
CREATE INDEX "platform_leads_assigned_idx" ON "platform_leads" ("assigned_to_id");
REVOKE ALL ON platform_leads FROM storageos_app;

CREATE TABLE "platform_lead_activities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "lead_id" UUID NOT NULL,
  "super_admin_id" UUID,
  -- note · call · demo · meeting · whatsapp · email_out · web_form · signup · quote · system
  "type" TEXT NOT NULL,
  "subject" TEXT,
  "content" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_lead_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id")
    REFERENCES "platform_leads" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_lead_activities_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_lead_activities_lead_idx"
  ON "platform_lead_activities" ("lead_id", "occurred_at" DESC);
REVOKE ALL ON platform_lead_activities FROM storageos_app;

CREATE TABLE "platform_lead_followups" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "lead_id" UUID NOT NULL,
  "super_admin_id" UUID,
  "assigned_to_id" UUID,
  "title" TEXT NOT NULL,
  "note" TEXT,
  "due_date" DATE NOT NULL,
  -- pending · done
  "status" TEXT NOT NULL DEFAULT 'pending',
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_lead_followups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_lead_followups_lead_id_fkey" FOREIGN KEY ("lead_id")
    REFERENCES "platform_leads" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_lead_followups_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "platform_lead_followups_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_lead_followups_status_idx" ON "platform_lead_followups" ("status", "due_date");
CREATE INDEX "platform_lead_followups_lead_idx" ON "platform_lead_followups" ("lead_id");
REVOKE ALL ON platform_lead_followups FROM storageos_app;

-- Una propuesta de cuota puede ir a un lead que aún no tiene cuenta; al
-- vincularse a su tenant pasa a ser suya. Borrar un lead borra antes sus
-- propuestas sin tenant (lo hace la app).
ALTER TABLE "platform_quote_offers" ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "platform_quote_offers" ADD COLUMN "lead_id" UUID;
ALTER TABLE "platform_quote_offers" ADD CONSTRAINT "platform_quote_offers_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "platform_leads" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "platform_quote_offers_lead_idx" ON "platform_quote_offers" ("lead_id");

-- Los mensajes del formulario de la web pasan a ser leads: uno por email
-- (los demás mensajes del mismo email, como actividad del mismo lead).
INSERT INTO "platform_leads" (
  "status", "source", "company_name", "contact_name", "email", "phone", "units", "profile",
  "message", "assigned_to_id", "contacted_at", "first_response_at", "created_at", "updated_at"
)
SELECT DISTINCT ON (lower(m."email"))
  CASE WHEN EXISTS (
    SELECT 1 FROM "platform_contact_messages" o
    WHERE lower(o."email") = lower(m."email") AND o."handled_at" IS NULL AND o."replied_at" IS NULL
  ) THEN 'new' ELSE 'contacted' END,
  'web_contact', m."company", m."name", lower(m."email"), m."phone", m."units", m."profile",
  m."message", m."assigned_to_id",
  (SELECT min(coalesce(o."replied_at", o."handled_at")) FROM "platform_contact_messages" o
    WHERE lower(o."email") = lower(m."email")),
  (SELECT min(o."replied_at") FROM "platform_contact_messages" o
    WHERE lower(o."email") = lower(m."email")),
  m."created_at", m."created_at"
FROM "platform_contact_messages" m
ORDER BY lower(m."email"), m."created_at";

INSERT INTO "platform_lead_activities" ("lead_id", "type", "content", "occurred_at", "created_at")
SELECT l."id", 'web_form', m."message", m."created_at", m."created_at"
FROM "platform_contact_messages" m
JOIN "platform_leads" l ON l."source" = 'web_contact' AND l."email" = lower(m."email");

INSERT INTO "platform_lead_activities"
  ("lead_id", "type", "subject", "content", "occurred_at", "created_at")
SELECT l."id", 'email_out', m."reply_subject", m."reply_body", m."replied_at", m."replied_at"
FROM "platform_contact_messages" m
JOIN "platform_leads" l ON l."source" = 'web_contact' AND l."email" = lower(m."email")
WHERE m."replied_at" IS NOT NULL AND m."reply_body" IS NOT NULL;

INSERT INTO "platform_lead_activities" ("lead_id", "type", "content", "occurred_at", "created_at")
SELECT l."id", 'note', m."note", m."created_at", m."created_at"
FROM "platform_contact_messages" m
JOIN "platform_leads" l ON l."source" = 'web_contact' AND l."email" = lower(m."email")
WHERE coalesce(m."note", '') <> '';

-- Los tenants que están ahora en prueba: su lead (el del formulario si
-- escribió con el mismo email, o uno nuevo «Registro en la web»).
WITH owners AS (
  SELECT DISTINCT ON (u."tenant_id") u."tenant_id", u."email", u."full_name"
  FROM "users" u
  WHERE u."role" = 'owner'
  ORDER BY u."tenant_id", u."created_at"
)
UPDATE "platform_leads" l
SET "tenant_id" = t."id", "status" = 'trial', "trial_at" = t."created_at", "updated_at" = now()
FROM "tenants" t
JOIN owners o ON o."tenant_id" = t."id"
WHERE t."status" = 'trial' AND t."deleted_at" IS NULL AND NOT t."billing_exempt"
  AND l."email" = lower(o."email") AND l."tenant_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "platform_leads" x WHERE x."tenant_id" = t."id");

WITH owners AS (
  SELECT DISTINCT ON (u."tenant_id") u."tenant_id", u."email", u."full_name"
  FROM "users" u
  WHERE u."role" = 'owner'
  ORDER BY u."tenant_id", u."created_at"
)
INSERT INTO "platform_leads" (
  "status", "source", "company_name", "contact_name", "email", "tenant_id", "trial_at",
  "created_at", "updated_at"
)
SELECT 'trial', 'signup', t."name", o."full_name", lower(o."email"), t."id", t."created_at",
  t."created_at", now()
FROM "tenants" t
JOIN owners o ON o."tenant_id" = t."id"
WHERE t."status" = 'trial' AND t."deleted_at" IS NULL AND NOT t."billing_exempt"
  AND NOT EXISTS (SELECT 1 FROM "platform_leads" x WHERE x."tenant_id" = t."id");
