-- Un cobro devuelto (contracargo, devolución SEPA o N43) vuelve a dejar la
-- factura vencida: el escalado de impagos empieza de cero desde ese día. Las
-- acciones del ciclo anterior se conservan como historial (`superseded_at`) y
-- dejan de contar para el índice anti-duplicado.
ALTER TABLE "dunning_actions" ADD COLUMN "superseded_at" TIMESTAMPTZ(6);

DROP INDEX "dunning_actions_active_unique";
CREATE UNIQUE INDEX "dunning_actions_active_unique"
    ON "dunning_actions"("tenant_id", "invoice_id", "action_type")
    WHERE "status" IN ('scheduled', 'executed') AND "superseded_at" IS NULL;
