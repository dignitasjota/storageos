-- Carteras para la dirección: aviso de prospectos repartidos por la dirección
-- a los que su comercial aún no ha llamado (una vez por prospecto y reparto).

ALTER TABLE platform_sales_settings
  ADD COLUMN first_contact_alert_days INTEGER NOT NULL DEFAULT 5;

ALTER TABLE platform_leads
  ADD COLUMN sales_first_contact_warned_at TIMESTAMPTZ(6);
