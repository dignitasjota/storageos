-- Avisos del panel admin por Telegram y Slack: urgentes del «Hoy» (diario) y
-- resumen semanal. El token del bot y la URL del webhook van cifrados.
ALTER TABLE "platform_alert_settings"
  ADD COLUMN "telegram_bot_token_encrypted" TEXT,
  ADD COLUMN "telegram_chat_id" TEXT,
  ADD COLUMN "slack_webhook_url_encrypted" TEXT,
  ADD COLUMN "chat_daily_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chat_weekly_enabled" BOOLEAN NOT NULL DEFAULT false;
