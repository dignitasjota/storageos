-- Avisos comerciales por Telegram/Slack al momento (altas, extras contratados
-- o cancelados, cambios de plan, primer contrato en prueba, interés).
ALTER TABLE "platform_alert_settings"
  ADD COLUMN "chat_commercial_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chat_commercial_last_at" TIMESTAMPTZ(6);
