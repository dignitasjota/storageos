-- Remitente de los correos de la plataforma a los tenants (nombre, dirección y
-- dirección de respuesta), común y opcionalmente por tipo de correo (cuenta,
-- suscripción, mensajes del administrador, avisos al equipo). Vacío = las
-- variables EMAIL_FROM_NAME / EMAIL_FROM_ADDRESS.
ALTER TABLE "platform_email_settings" ADD COLUMN "senders" JSONB NOT NULL DEFAULT '{}'::jsonb;
