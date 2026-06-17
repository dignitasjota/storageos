-- CRM: aviso de contrato "vence pronto" (cron contract_ending_soon).
ALTER TABLE "contracts" ADD COLUMN "ending_soon_notified_at" TIMESTAMPTZ(6);
