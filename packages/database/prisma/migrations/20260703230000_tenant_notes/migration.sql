-- Notas estratégicas y valor (LTV) del tenant, para el super admin (customer
-- success). Solo lectura/gestión interna; no lo ve el tenant.
ALTER TABLE "tenants" ADD COLUMN "ltv_tier" TEXT;
ALTER TABLE "tenants" ADD COLUMN "strategic_notes" TEXT;
ALTER TABLE "tenants" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
