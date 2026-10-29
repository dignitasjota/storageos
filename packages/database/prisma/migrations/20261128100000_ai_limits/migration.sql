-- Asistente IA del panel: clave y modelo editables desde el panel admin (con
-- las variables de entorno como respaldo) y límite de consultas por tenant.

-- Un registro. Global → REVOKE.
CREATE TABLE "platform_ai_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- Clave de Anthropic cifrada (null = se usa ANTHROPIC_API_KEY).
  "api_key_encrypted" TEXT,
  -- Modelo (null = AI_MODEL o el de por defecto).
  "model" TEXT,
  -- Consultas al mes por tenant incluidas en su plan.
  "monthly_query_limit" INTEGER NOT NULL DEFAULT 300,
  -- Consultas al día por usuario del equipo.
  "daily_user_limit" INTEGER NOT NULL DEFAULT 50,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_ai_settings_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_ai_settings" FROM storageos_app;

-- Qué llamadas al modelo son una consulta (la primera de cada pregunta).
ALTER TABLE "ai_usage_events" ADD COLUMN "counts_as_query" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ai_usage_events_queries_idx" ON "ai_usage_events" ("tenant_id", "created_at")
  WHERE "counts_as_query";

-- Consultas al mes que añade un extra (por unidad contratada).
ALTER TABLE "subscription_addons" ADD COLUMN "grants_ai_queries" INTEGER;

-- Límite propio del tenant (null = el general + extras) y último aviso enviado
-- (AAAA-MM:80 o AAAA-MM:100).
ALTER TABLE "tenants"
  ADD COLUMN "ai_monthly_limit" INTEGER,
  ADD COLUMN "ai_limit_notified" TEXT;
