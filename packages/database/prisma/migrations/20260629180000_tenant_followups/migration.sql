-- Seguimientos/recordatorios del super admin sobre un tenant (tarea con fecha
-- de recordatorio + estado pending/done).
CREATE TABLE "tenant_followups" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "super_admin_id" UUID,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tenant_followups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_followups_tenant_id_idx" ON "tenant_followups" ("tenant_id");
CREATE INDEX "tenant_followups_status_due_date_idx" ON "tenant_followups" ("status", "due_date");

ALTER TABLE "tenant_followups"
    ADD CONSTRAINT "tenant_followups_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_followups"
    ADD CONSTRAINT "tenant_followups_super_admin_id_fkey"
    FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
