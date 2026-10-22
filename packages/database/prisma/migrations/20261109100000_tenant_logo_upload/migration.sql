-- Logo del tenant subido como fichero al bucket público (antes solo se podía
-- pegar una URL). Con la clave guardada, el servidor puede usar el logo para
-- dibujar iconos sin descargar direcciones ajenas.
ALTER TABLE "tenants" ADD COLUMN "portal_logo_key" TEXT;
