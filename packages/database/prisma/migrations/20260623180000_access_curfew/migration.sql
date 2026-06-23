-- Toque de queda por local: franja en la que se bloquea el acceso (en la zona
-- horaria del local). Las credenciales con bypass_curfew (staff) lo saltan.
ALTER TABLE "facilities" ADD COLUMN "access_curfew_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "facilities" ADD COLUMN "access_curfew_start" TEXT; -- "HH:MM"
ALTER TABLE "facilities" ADD COLUMN "access_curfew_end" TEXT;   -- "HH:MM"

ALTER TABLE "access_credentials" ADD COLUMN "bypass_curfew" BOOLEAN NOT NULL DEFAULT false;
