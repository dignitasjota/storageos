-- Resumen semanal de KPIs por email al super admin: flag en el singleton de config.
ALTER TABLE platform_alert_settings ADD COLUMN weekly_digest_enabled BOOLEAN NOT NULL DEFAULT false;
