-- Revisión de «Seguridad y sistema» del panel admin.

-- Los intentos de entrar al panel admin también son eventos de seguridad.
ALTER TYPE "security_event_type" ADD VALUE IF NOT EXISTS 'admin_login_failed';
ALTER TYPE "security_event_type" ADD VALUE IF NOT EXISTS 'admin_two_factor_failed';

-- Recuperar la contraseña / elegirla al recibir la invitación, y cerrar de verdad
-- los access tokens ya emitidos (logout, cambio de contraseña…).
ALTER TABLE "super_admins"
  ADD COLUMN "password_reset_token_hash" TEXT,
  ADD COLUMN "password_reset_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "tokens_valid_after" TIMESTAMPTZ(6);

-- De qué sesión sale cada una al rotar (margen de gracia y respuesta perdida).
ALTER TABLE "super_admin_sessions" ADD COLUMN "rotated_from_id" UUID;
CREATE INDEX "super_admin_sessions_rotated_from_idx" ON "super_admin_sessions" ("rotated_from_id");

-- Última alerta de fuerza bruta por email/IP: sin repetir entre réplicas ni al reiniciar.
CREATE TABLE "security_alert_states" (
  "kind" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "last_sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "security_alert_states_pkey" PRIMARY KEY ("kind", "identifier")
);
REVOKE ALL ON security_alert_states FROM storageos_app;

-- Política de acceso al panel admin (un registro).
CREATE TABLE "platform_security_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "require_admin_two_factor" BOOLEAN NOT NULL DEFAULT false,
  "admin_two_factor_grace_days" INTEGER NOT NULL DEFAULT 7,
  "admin_two_factor_required_since" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_security_settings_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON platform_security_settings FROM storageos_app;
