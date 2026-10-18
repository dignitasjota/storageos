-- Tenant suspendido: cobros a sus inquilinos y correos en espera hasta que pague.
ALTER TABLE "invoices" ADD COLUMN "charge_held_at" TIMESTAMPTZ(6);
ALTER TABLE "communications" ADD COLUMN "held_at" TIMESTAMPTZ(6);

CREATE INDEX "invoices_charge_held_at_idx" ON "invoices" ("charge_held_at") WHERE "charge_held_at" IS NOT NULL;
CREATE INDEX "communications_held_at_idx" ON "communications" ("held_at") WHERE "held_at" IS NOT NULL;
