-- Revisión de Subidas de precio: preaviso configurable, fecha por contrato
-- (los pagados por adelantado cambian al empezar su siguiente periodo) y
-- constancia del aviso a cada inquilino.

ALTER TABLE "tenants"
  ADD COLUMN "rent_increase_notice_days" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "rent_increases"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6);

ALTER TABLE "rent_increase_items"
  ADD COLUMN "effective_date" DATE,
  ADD COLUMN "notice_status" TEXT,
  ADD COLUMN "notice_communication_id" UUID,
  ADD COLUMN "notice_sent_at" TIMESTAMPTZ(6);

UPDATE "rent_increase_items" i
   SET "effective_date" = r."effective_date",
       "notice_status" = CASE WHEN r."notice_sent" THEN 'sent' ELSE NULL END
  FROM "rent_increases" r
 WHERE r."id" = i."rent_increase_id";

ALTER TABLE "rent_increase_items" ALTER COLUMN "effective_date" SET NOT NULL;

ALTER TABLE "rent_increase_items"
  ADD CONSTRAINT "rent_increase_items_notice_communication_id_fkey"
  FOREIGN KEY ("notice_communication_id") REFERENCES "communications"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "rent_increase_items_pending_idx"
  ON "rent_increase_items" ("tenant_id", "effective_date")
  WHERE "status" = 'pending';

CREATE INDEX "rent_increase_items_contract_idx"
  ON "rent_increase_items" ("contract_id");
