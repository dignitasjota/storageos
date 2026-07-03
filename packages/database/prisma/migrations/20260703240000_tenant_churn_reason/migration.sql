-- Motivo de baja (churn) del tenant, para el reporte «churn por razón» del super
-- admin. `churn_reason` es texto validado por Zod (no enum PG, como el resto de
-- enums del proyecto). Se fija al suspender/cancelar y se limpia al reactivar.
-- `canceled_at` marca cuándo se dio de baja (más fiable que `updated_at`).
ALTER TABLE "tenants" ADD COLUMN "churn_reason" TEXT;
ALTER TABLE "tenants" ADD COLUMN "canceled_at" TIMESTAMPTZ(6);
