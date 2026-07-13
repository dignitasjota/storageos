-- Bizum vía Redsys: el tenant declara que su comercio acepta Bizum (su banco
-- debe tenerlo activo en el TPV). Si está activo, el redirect puede forzar
-- DS_MERCHANT_PAYMETHODS='z' (Bizum) además de 'C' (tarjeta).
ALTER TABLE "redsys_settings" ADD COLUMN "bizum_enabled" BOOLEAN NOT NULL DEFAULT false;
