-- Accesos adicionales (autoservicio del inquilino): máximo de credenciales
-- extra que un inquilino puede crearse desde su portal (p. ej. para familiares).
ALTER TABLE "tenants" ADD COLUMN "extra_access_limit" INTEGER NOT NULL DEFAULT 2;
