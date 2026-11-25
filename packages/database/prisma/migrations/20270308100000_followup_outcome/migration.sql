-- Seguimientos del panel admin (tenants y leads): al marcarlos hechos se
-- guarda «qué pasó» y quién los cerró.

ALTER TABLE "tenant_followups"
  ADD COLUMN "outcome" TEXT,
  ADD COLUMN "completed_by_id" UUID;
ALTER TABLE "tenant_followups"
  ADD CONSTRAINT "tenant_followups_completed_by_id_fkey" FOREIGN KEY ("completed_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "platform_lead_followups"
  ADD COLUMN "outcome" TEXT,
  ADD COLUMN "completed_by_id" UUID;
ALTER TABLE "platform_lead_followups"
  ADD CONSTRAINT "platform_lead_followups_completed_by_id_fkey" FOREIGN KEY ("completed_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- La pestaña «Hechos» de la bandeja mira los de los últimos 30 días.
CREATE INDEX "tenant_followups_completed_idx" ON "tenant_followups" ("completed_at")
  WHERE "status" = 'done';
CREATE INDEX "platform_lead_followups_completed_idx" ON "platform_lead_followups" ("completed_at")
  WHERE "status" = 'done';
