-- Fin del plan gratuito: día en que la cuenta pasa a Basic (se fija al avisar,
-- 30 días antes). Null = aún sin avisar o ya no está en el plan gratuito.
ALTER TABLE "tenants" ADD COLUMN "free_plan_ends_at" TIMESTAMPTZ(6);
