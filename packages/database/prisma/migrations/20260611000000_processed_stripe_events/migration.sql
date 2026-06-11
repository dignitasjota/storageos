-- Dedup de webhooks Stripe entrantes.
--
-- Stripe garantiza entrega at-least-once: reintentos y duplicados (incluso
-- concurrentes) son normales. El `StripeWebhookController` inserta el
-- `event.id` ANTES de procesar; un duplicado choca con la PK y se descarta.
-- Si el handler falla, la fila se borra para que el retry de Stripe vuelva
-- a entrar.
--
-- Tabla global (sin tenant_id, sin RLS): el webhook llega antes de resolver
-- tenant context; solo se accede via PrismaAdminService. Mismo patron que
-- `security_events` / `super_admin_audit_logs`. Limpieza a 30 dias via cron.

-- CreateTable
CREATE TABLE "processed_stripe_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_stripe_events_received_at_idx" ON "processed_stripe_events"("received_at");
