-- Relleno de la revisión de Cobros (va aparte: un valor nuevo de un enum no se
-- puede usar en la misma transacción en que se añade).

-- La fianza retenida aplicada a una factura deja de contar como cobro nuevo.
UPDATE "payments" SET "method_type" = 'deposit'
  WHERE "method_type" = 'other' AND "notes" = 'Aplicado de la fianza retenida';

-- Un adeudo que el banco cobró pero no se pudo aplicar (la factura ya estaba
-- pagada o anulada) no es un recibo rechazado: hay que devolver ese dinero.
UPDATE "sepa_remittance_items" SET "status" = 'unapplied'
  WHERE "status" = 'failed' AND COALESCE("failure_reason", '') <> 'Rechazado por el banco';

-- Método de las devoluciones ya registradas: el del cobro que se devolvió.
UPDATE "invoice_refunds" r SET "method" = p."method_type"
  FROM "payments" p
  WHERE r."payment_id" = p."id" AND r."method" IS NULL;

-- El cobro de cada adeudo ya cobrado: el que registró su confirmación (lleva
-- la referencia del adeudo en la nota).
UPDATE "sepa_remittance_items" i SET "payment_id" = (
  SELECT p."id" FROM "payments" p
  WHERE p."invoice_id" = i."invoice_id"
    AND p."method_type" = 'sepa_debit'
    AND p."notes" LIKE '%' || i."end_to_end_id" || '%'
  ORDER BY p."created_at" DESC
  LIMIT 1
)
WHERE i."status" IN ('collected', 'returned') AND i."payment_id" IS NULL;
