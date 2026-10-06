-- Motivo de pérdida de un contacto como dato (para la sugerencia de precio y
-- los informes). `lost_reason` sigue guardando el detalle en texto libre.
ALTER TABLE "leads" ADD COLUMN "lost_reason_code" TEXT;
CREATE INDEX "leads_lost_reason_code_idx" ON "leads"("tenant_id", "lost_reason_code", "lost_at");
