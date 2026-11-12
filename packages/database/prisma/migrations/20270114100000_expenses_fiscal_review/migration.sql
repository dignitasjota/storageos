-- Revisión de Gastos y Fiscalidad.

-- 1. La referencia de un gasto sincronizado de Google o Meta Ads era única entre
--    todas las empresas: si dos usaban el mismo id de campaña, a la segunda le
--    fallaba la sincronización. Ahora es única dentro de cada empresa.
DROP INDEX IF EXISTS "expenses_external_ref_key";
CREATE UNIQUE INDEX "expenses_tenant_id_external_ref_key"
  ON "expenses" ("tenant_id", "external_ref");

-- 2. De qué plantilla recurrente sale cada gasto generado (para enseñarlo).
ALTER TABLE "expenses" ADD COLUMN "recurring_expense_id" UUID;
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_recurring_expense_id_fkey"
  FOREIGN KEY ("recurring_expense_id") REFERENCES "recurring_expenses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Datos del cliente congelados al emitir: el libro de IVA, el 347 y las
--    exportaciones dejan de cambiar si después se edita o se anonimiza la ficha.
ALTER TABLE "invoices" ADD COLUMN "customer_name_snapshot" TEXT;
ALTER TABLE "invoices" ADD COLUMN "customer_tax_id_snapshot" TEXT;
ALTER TABLE "invoices" ADD COLUMN "customer_address_snapshot" TEXT;

-- Las ya emitidas: con los datos que tiene hoy la ficha (los mejores que hay).
UPDATE "invoices" i
SET
  "customer_name_snapshot" = CASE
    WHEN c."customer_type" = 'business' THEN COALESCE(c."company_name", 'Empresa')
    ELSE COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c."first_name", c."last_name")), ''), 'Cliente')
  END,
  "customer_tax_id_snapshot" = c."document_number",
  "customer_address_snapshot" = NULLIF(
    CONCAT_WS(', ', NULLIF(c."address", ''), NULLIF(TRIM(CONCAT_WS(' ', c."postal_code", c."city")), '')),
    ''
  )
FROM "customers" c
WHERE i."customer_id" = c."id"
  AND i."status" <> 'draft'
  AND i."invoice_number" NOT LIKE 'DRAFT-%';
