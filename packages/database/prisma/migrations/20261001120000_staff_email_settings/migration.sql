-- Avisos por email al equipo del tenant (propietarios y gestores): lead nuevo
-- desde la web, reserva online, baja solicitada, incidencia del inquilino.
-- Activados por defecto; el jsonb guarda solo los apagados.
ALTER TABLE "tenants" ADD COLUMN "staff_email_settings" JSONB NOT NULL DEFAULT '{}'::jsonb;
