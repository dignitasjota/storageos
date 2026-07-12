-- Informe mensual por email al operador (digest del tenant): ocupación, ingresos,
-- morosidad, altas y leads del mes. Opt-in por tenant.
ALTER TABLE "tenants" ADD COLUMN "monthly_digest_enabled" BOOLEAN NOT NULL DEFAULT false;
