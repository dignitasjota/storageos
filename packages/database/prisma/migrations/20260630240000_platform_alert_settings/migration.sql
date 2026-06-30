-- Config de alertas proactivas de plataforma (singleton, 1 fila). El super admin
-- recibe un digest por email cuando hay tenants en past_due o trials por expirar.
-- Sin RLS: config global de plataforma (solo el super admin la consulta).
CREATE TABLE "platform_alert_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "alert_email" TEXT,
    "notify_past_due" BOOLEAN NOT NULL DEFAULT true,
    "notify_trial_expiring" BOOLEAN NOT NULL DEFAULT true,
    "trial_expiring_days" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_alert_settings_pkey" PRIMARY KEY ("id")
);
