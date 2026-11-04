-- Mejoras de «Seguridad y sistema» del panel admin.

ALTER TYPE "security_event_type" ADD VALUE IF NOT EXISTS 'login_blocked';

-- Qué hizo cada sesión de impersonación (no toda la actividad del tenant en ese rato).
ALTER TABLE "audit_logs" ADD COLUMN "impersonation_id" UUID;
CREATE INDEX "audit_logs_impersonation_idx" ON "audit_logs" ("impersonation_id")
  WHERE "impersonation_id" IS NOT NULL;

-- Bloqueo manual de una IP o un email en las entradas.
CREATE TABLE "security_blocks" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "reason" TEXT,
  "expires_at" TIMESTAMPTZ(6),
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "security_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "security_blocks_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "security_blocks_kind_value_key" ON "security_blocks" ("kind", "value");
REVOKE ALL ON security_blocks FROM storageos_app;

-- Cada cuánto se repite una alerta del mismo email o IP.
ALTER TABLE "platform_security_settings"
  ADD COLUMN "alert_cooldown_minutes" INTEGER NOT NULL DEFAULT 60;
