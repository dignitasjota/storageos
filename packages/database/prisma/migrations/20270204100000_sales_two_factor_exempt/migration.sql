-- Un comercial puede quedar exento de la verificación en dos pasos (lo decide la
-- dirección desde su ficha). Por defecto la tiene obligatoria.
ALTER TABLE "super_admins" ADD COLUMN "sales_two_factor_exempt" BOOLEAN NOT NULL DEFAULT false;
