-- Último aviso de entrega recibido de cada proveedor de correo: el panel admin
-- (Correo saliente) dice si el webhook de Brevo o Resend está conectado.
ALTER TABLE "platform_email_settings"
  ADD COLUMN "brevo_events_last_at" TIMESTAMPTZ(6),
  ADD COLUMN "resend_events_last_at" TIMESTAMPTZ(6);
