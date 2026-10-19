-- Cabecera de la web pública del tenant con el color de su marca.
ALTER TABLE "tenants" ADD COLUMN "web_header_branded" BOOLEAN NOT NULL DEFAULT false;
