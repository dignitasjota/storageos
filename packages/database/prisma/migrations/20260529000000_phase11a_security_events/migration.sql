-- Fase 11A.1: tabla global `security_events` para registrar eventos de
-- seguridad sin contexto de tenant (login contra slugs/emails inexistentes,
-- throttles disparados, reuso de refresh tokens, etc).
--
-- Sin RLS: tabla global, accesible solo via `PrismaAdminService` (rol
-- `storageos`). Los super admins la consultan desde `/admin/security-events`.
--
-- Retencion: 90 dias mediante cron diario (`security-events.cleanup`).

-- CreateEnum
CREATE TYPE "security_event_type" AS ENUM (
    'login_failed_email_not_found',
    'login_failed_tenant_not_found',
    'login_failed_wrong_password',
    'login_failed_throttled',
    'register_throttled',
    'password_reset_throttled',
    'invitation_token_invalid',
    'refresh_token_reuse'
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" "security_event_type" NOT NULL,
    "email_attempted" TEXT,
    "tenant_slug_attempted" TEXT,
    "ip_address" INET,
    "user_agent" TEXT,
    "reason" TEXT,
    "raw_metadata" JSONB,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_occurred_at_idx"
    ON "security_events" ("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_event_type_occurred_at_idx"
    ON "security_events" ("event_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_email_attempted_occurred_at_idx"
    ON "security_events" ("email_attempted", "occurred_at" DESC);

-- NO RLS: tabla global. Solo se accede desde el rol `storageos` (admin)
-- via `PrismaAdminService`. El rol `storageos_app` no la consulta nunca,
-- pero hereda los SELECT/INSERT/UPDATE/DELETE por defecto via ALTER DEFAULT
-- PRIVILEGES definido en `20260518230200_phase1a_app_role`. Como no existe
-- politica RLS y la tabla esta sin habilitar RLS, ambos roles pueden leer;
-- aceptamos ese riesgo porque ningun controller del lado tenant accede a
-- este modelo (solo `SecurityEventsController` bajo `AdminGuard`).
