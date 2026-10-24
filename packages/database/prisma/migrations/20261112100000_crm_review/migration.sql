-- Revisión del CRM.

-- Recompensa de referidos: descuento en la siguiente factura del que recomienda
-- (antes, un código de promoción que solo valía para un contrato nuevo).
ALTER TABLE "referrals"
  ADD COLUMN "reward_type" TEXT,
  ADD COLUMN "reward_value" DECIMAL(10,2),
  ADD COLUMN "reward_applied_at" TIMESTAMPTZ(6),
  ADD COLUMN "reward_invoice_id" UUID,
  ADD CONSTRAINT "referrals_reward_invoice_id_fkey" FOREIGN KEY ("reward_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;

-- Testimonios: solo los que el equipo publica salen en la web.
ALTER TABLE "reviews" ADD COLUMN "published_on_web" BOOLEAN NOT NULL DEFAULT false;
-- Se conservan los que ya se estaban mostrando (promotores con comentario).
UPDATE "reviews" SET "published_on_web" = true
  WHERE "status" = 'submitted' AND "nps_score" >= 9 AND "comment" IS NOT NULL AND btrim("comment") <> '';
