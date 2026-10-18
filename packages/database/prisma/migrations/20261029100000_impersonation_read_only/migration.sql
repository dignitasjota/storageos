-- Impersonación en solo lectura: el token lleva los permisos de `readonly` y
-- el API rechaza cualquier petición que no sea de lectura.
ALTER TABLE "impersonation_logs" ADD COLUMN "read_only" BOOLEAN NOT NULL DEFAULT false;
