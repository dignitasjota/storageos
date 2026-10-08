-- Cuándo se devolvió un cobro que ya estaba cobrado (devolución bancaria,
-- contracargo o fallo tardío de la domiciliación). Hasta ahora el cobro pasaba
-- a «fallido» sin fecha; los devueltos antiguos se reconocen por tener fecha
-- de cobro y se fechan con su última actualización.
ALTER TABLE "payments" ADD COLUMN "returned_at" TIMESTAMPTZ(6);

UPDATE "payments"
SET "returned_at" = "updated_at"
WHERE "status" = 'failed' AND "paid_at" IS NOT NULL;

CREATE INDEX "payments_tenant_id_returned_at_idx" ON "payments" ("tenant_id", "returned_at")
WHERE "returned_at" IS NOT NULL;
