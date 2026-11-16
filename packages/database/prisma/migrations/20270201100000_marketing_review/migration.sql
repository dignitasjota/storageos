-- Revisión de Marketing (PR 2): fallos medios y menores.

-- Chat de la web: horario del equipo (fuera de él se avisa al visitante) y
-- origen de la visita de quien escribe (sus reservas y contactos lo heredan).
ALTER TABLE "tenants" ADD COLUMN "web_chat_team_hours" JSONB;
ALTER TABLE "web_chat_conversations"
  ADD COLUMN "utm_source" TEXT,
  ADD COLUMN "utm_medium" TEXT,
  ADD COLUMN "utm_campaign" TEXT;

-- Canales de marketing: renovación periódica con un aviso por fecha y estado
-- de la sincronización del gasto con la plataforma de anuncios.
ALTER TABLE "marketing_channels"
  ADD COLUMN "renewal_months" INTEGER,
  ADD COLUMN "renewal_notified_on" DATE,
  ADD COLUMN "last_sync_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_sync_error" TEXT,
  ADD COLUMN "sync_failing_since" TIMESTAMPTZ(6),
  ADD COLUMN "sync_failure_notified_at" TIMESTAMPTZ(6);

-- Los avisos de renovación ya enviados no se repiten para la misma fecha.
UPDATE "marketing_channels"
   SET "renewal_notified_on" = "renews_on"
 WHERE "renews_on" IS NOT NULL
   AND "renews_on" <= CURRENT_DATE + 7;

-- Enlace de firma cifrado: el recordatorio reenvía el vigente en vez de anularlo.
ALTER TABLE "contracts" ADD COLUMN "signing_token_encrypted" TEXT;

-- Índices de los informes de Marketing.
CREATE INDEX IF NOT EXISTS "leads_tenant_created_idx" ON "leads"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "leads_tenant_utm_source_idx" ON "leads"("tenant_id", "utm_source");
CREATE INDEX IF NOT EXISTS "web_events_created_idx" ON "web_events"("created_at");
CREATE INDEX IF NOT EXISTS "expenses_tenant_id_marketing_channel_id_idx"
  ON "expenses"("tenant_id", "marketing_channel_id");
