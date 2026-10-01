-- Datos sensibles de un envío (p. ej. el PIN de acceso), cifrados. El cuerpo
-- guardado lleva una marca en su lugar: el panel muestra «••••» y el valor
-- real solo se pone al enviar el correo.
ALTER TABLE "communications" ADD COLUMN "secrets_encrypted" TEXT;

-- Texto del correo de acceso: ya no dice que el código «no volverá a mostrarse»
-- (el área de clientes lo muestra siempre). Solo en las plantillas sin editar.
UPDATE "message_templates"
SET
  "body_text" = 'Hola {{customer.firstName}},' || chr(10) || chr(10) ||
    'Ya puedes acceder a tu trastero {{unit.code}} en {{facility.name}}.' || chr(10) || chr(10) ||
    'Código de acceso: {{credential.secret}}' || chr(10) || chr(10) ||
    'También lo tienes siempre en tu área de clientes: {{portal.url}}' || chr(10) || chr(10) ||
    'Un saludo,' || chr(10) || 'El equipo de {{tenant.name}}',
  "body_html" = replace(
    "body_html",
    '<p style="font-size:12px;color:#888">Guárdalo bien: este código no volverá a mostrarse. Si lo pierdes, contáctanos para emitir uno nuevo.</p>',
    '<p>También lo tienes siempre en tu <a href="{{portal.url}}">área de clientes</a>.</p>'
  ),
  "updated_at" = now()
WHERE "code" = 'access_credential_issued_email'
  AND "body_text" LIKE '%Guárdalo bien: este código no volverá a mostrarse.%';
