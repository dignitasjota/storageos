-- Índices para las agregaciones cross-tenant del panel super admin.
-- La tabla `tenants` no tenía NINGÚN índice (solo la PK) → seq scan en cada
-- query admin (métricas, at-risk, health, adoption, trials…), multiplicado por
-- los Promise.all de 10-15 queries y los refetch cada 60s.
CREATE INDEX IF NOT EXISTS "tenants_deleted_at_status_idx" ON "tenants" ("deleted_at", "status");
CREATE INDEX IF NOT EXISTS "tenants_status_trial_ends_at_idx" ON "tenants" ("status", "trial_ends_at");
CREATE INDEX IF NOT EXISTS "tenants_deleted_at_created_at_idx" ON "tenants" ("deleted_at", "created_at");
CREATE INDEX IF NOT EXISTS "tenants_status_updated_at_idx" ON "tenants" ("status", "updated_at");

-- Ventanas temporales de facturación (getInvoicing, getTenantsHealth).
CREATE INDEX IF NOT EXISTS "invoices_tenant_id_issue_date_idx" ON "invoices" ("tenant_id", "issue_date");
CREATE INDEX IF NOT EXISTS "payments_tenant_id_status_paid_at_idx" ON "payments" ("tenant_id", "status", "paid_at");
