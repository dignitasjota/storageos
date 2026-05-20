-- Fase 12A.3: audit logs globales del super admin.
--
-- Hasta ahora las acciones del super admin (login, 2FA, impersonation,
-- suspend/reactivate de tenants) iban al pino logger porque
-- `audit_logs.tenant_id` es NOT NULL. Esta tabla replica el patron de
-- `security_events` (global, sin RLS, solo accesible via PrismaAdminService)
-- pero registrando ACCIONES exitosas del propio super admin en lugar de
-- intentos fallidos.

-- CreateTable
CREATE TABLE "super_admin_audit_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "super_admin_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" UUID,
    "target_tenant_id" UUID,
    "changes" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,

    CONSTRAINT "super_admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "super_admin_audit_logs_occurred_at_idx" ON "super_admin_audit_logs"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "super_admin_audit_logs_super_admin_id_occurred_at_idx" ON "super_admin_audit_logs"("super_admin_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "super_admin_audit_logs_target_tenant_id_occurred_at_idx" ON "super_admin_audit_logs"("target_tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "super_admin_audit_logs_action_occurred_at_idx" ON "super_admin_audit_logs"("action", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "super_admin_audit_logs" ADD CONSTRAINT "super_admin_audit_logs_super_admin_id_fkey" FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
