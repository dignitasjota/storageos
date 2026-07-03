-- Add-ons de capacidad: cuántas unidades de cada recurso aporta el add-on (por
-- cada unidad de `quantity`). Amplían los límites del plan (maxUnits/…) para el
-- enforcement. null = el add-on no aporta ese recurso.
ALTER TABLE "subscription_addons" ADD COLUMN "grants_units" INTEGER;
ALTER TABLE "subscription_addons" ADD COLUMN "grants_facilities" INTEGER;
ALTER TABLE "subscription_addons" ADD COLUMN "grants_users" INTEGER;
