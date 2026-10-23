-- Un mandato SEPA caduca si pasan 36 meses sin presentar ningún adeudo
-- (Rulebook SEPA CORE). Se guarda la fecha del último cobro de cada mandato.
-- Relleno: la fecha de cobro de su último adeudo cobrado; un mandato ya
-- recurrente sin rastro (importado como «ya cobrado») cuenta desde su alta.

ALTER TABLE "sepa_mandates" ADD COLUMN "last_collected_at" DATE;
ALTER TABLE "platform_sepa_mandates" ADD COLUMN "last_collected_at" DATE;

UPDATE "sepa_mandates" m
SET "last_collected_at" = COALESCE(
  (SELECT MAX(r."collection_date")
     FROM "sepa_remittance_items" i
     JOIN "sepa_remittances" r ON r."id" = i."remittance_id"
    WHERE i."mandate_id" = m."id" AND i."status" IN ('collected', 'returned')),
  CASE WHEN m."sequence_type" = 'RCUR' THEN m."created_at"::date END
);

UPDATE "platform_sepa_mandates" m
SET "last_collected_at" = COALESCE(
  (SELECT MAX(r."collection_date")
     FROM "platform_sepa_remittance_items" i
     JOIN "platform_sepa_remittances" r ON r."id" = i."remittance_id"
    WHERE i."mandate_id" = m."id" AND i."item_status" IN ('collected', 'bounced')),
  CASE WHEN m."sequence_type" = 'RCUR' THEN m."created_at"::date END
);
