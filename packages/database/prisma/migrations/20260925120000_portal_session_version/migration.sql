-- Versión de sesión del portal del inquilino: va dentro del JWT del portal
-- (`sv`) y se compara en cada request. Incrementarla invalida TODAS las
-- sesiones vivas del inquilino (antes eran JWT de 48 h no revocables).
ALTER TABLE "customers" ADD COLUMN "portal_session_version" INTEGER NOT NULL DEFAULT 0;
