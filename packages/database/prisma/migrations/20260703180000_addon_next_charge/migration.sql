-- Fecha del próximo cobro previsto de cada add-on del tenant (recordatorio de
-- cobro manual). Al asignar el add-on toca cobrarlo; cada cobro avanza +1 mes.
-- Los existentes se marcan a "ahora" (revisarlos en el próximo ciclo).
ALTER TABLE "tenant_subscription_addons" ADD COLUMN "next_charge_at" TIMESTAMPTZ(6);
UPDATE "tenant_subscription_addons" SET "next_charge_at" = now() WHERE "next_charge_at" IS NULL;
