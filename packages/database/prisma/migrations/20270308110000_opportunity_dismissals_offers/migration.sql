-- Oportunidades de venta de extras: candidatos descartados («no le interesa»)
-- y el registro de cada propuesta enviada (para su estado y la tasa de
-- aceptación). Tablas de la plataforma: solo las usa el super admin.

CREATE TABLE "platform_opportunity_dismissals" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "addon_id" UUID NOT NULL,
  -- Hasta cuándo (null = siempre).
  "until" TIMESTAMPTZ(6),
  "reason" TEXT NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_opportunity_dismissals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_opportunity_dismissals_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_opportunity_dismissals_addon_id_fkey" FOREIGN KEY ("addon_id")
    REFERENCES "subscription_addons" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_opportunity_dismissals_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_opportunity_dismissals_tenant_addon_key"
  ON "platform_opportunity_dismissals" ("tenant_id", "addon_id");

CREATE TABLE "platform_addon_offers" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "addon_id" UUID NOT NULL,
  "super_admin_id" UUID,
  "trial_days" INTEGER,
  "trial_until" TIMESTAMPTZ(6),
  -- Correos encolados (null en las anteriores a este registro).
  "recipients" INTEGER,
  -- single · bulk
  "source" TEXT NOT NULL DEFAULT 'single',
  "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_addon_offers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_addon_offers_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_addon_offers_addon_id_fkey" FOREIGN KEY ("addon_id")
    REFERENCES "subscription_addons" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_addon_offers_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_addon_offers_addon_sent_idx"
  ON "platform_addon_offers" ("addon_id", "sent_at" DESC);
CREATE INDEX "platform_addon_offers_tenant_addon_idx"
  ON "platform_addon_offers" ("tenant_id", "addon_id", "sent_at" DESC);

REVOKE ALL ON "platform_opportunity_dismissals" FROM storageos_app;
REVOKE ALL ON "platform_addon_offers" FROM storageos_app;

-- Relleno: las propuestas ya enviadas quedaban solo en el registro de acciones.
INSERT INTO "platform_addon_offers"
  ("tenant_id", "addon_id", "super_admin_id", "trial_days", "trial_until", "source", "sent_at")
SELECT l."target_tenant_id",
       (l."changes" ->> 'addonId')::uuid,
       l."super_admin_id",
       (l."changes" ->> 'trialDays')::int,
       CASE WHEN (l."changes" ->> 'trialDays') IS NOT NULL
            THEN l."occurred_at" + make_interval(days => (l."changes" ->> 'trialDays')::int)
       END,
       'single',
       l."occurred_at"
FROM "super_admin_audit_logs" l
JOIN "tenants" t ON t."id" = l."target_tenant_id"
JOIN "subscription_addons" a ON a."id"::text = l."changes" ->> 'addonId'
WHERE l."action" = 'admin.saas_addon.proposed'
  AND ((l."changes" ->> 'trialDays') IS NULL OR (l."changes" ->> 'trialDays') ~ '^[0-9]+$');
