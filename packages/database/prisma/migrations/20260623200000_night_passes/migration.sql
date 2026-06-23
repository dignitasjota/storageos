-- Pases nocturnos: credenciales de un solo uso (max_uses) que se cobran.
-- max_uses NULL = ilimitado (credenciales normales). uses_count cuenta usos OK.
ALTER TABLE "access_credentials" ADD COLUMN "max_uses" INTEGER;
ALTER TABLE "access_credentials" ADD COLUMN "uses_count" INTEGER NOT NULL DEFAULT 0;

-- Config del pase nocturno por tenant (precio del pase de un solo uso).
ALTER TABLE "tenants" ADD COLUMN "night_pass_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "night_pass_price" DECIMAL(10, 2) NOT NULL DEFAULT 0;
