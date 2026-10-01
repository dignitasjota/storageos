-- «Suscripción y facturación» se separa en dos tipos de correo: la Suscripción
-- (bienvenida, fin de la prueba) arranca con lo que hubiera configurado para
-- Facturación, para que nada cambie hasta que se edite.
UPDATE "platform_email_settings"
SET "senders" = "senders" || jsonb_build_object('subscription', "senders" -> 'billing')
WHERE "senders" ? 'billing' AND NOT ("senders" ? 'subscription');

-- Texto de la variable {tipo} del nombre del remitente, por correo concreto
-- (solo los cambiados; ausente = el de por defecto).
ALTER TABLE "platform_email_settings" ADD COLUMN "tipo_labels" JSONB NOT NULL DEFAULT '{}'::jsonb;
