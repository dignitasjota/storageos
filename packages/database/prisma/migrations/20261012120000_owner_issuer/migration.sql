-- Plan Administrador: las facturas de los contratos de un propietario las
-- emite él (su NIF, su serie y su cadena Veri*Factu). owner_id null = el
-- propio tenant.
ALTER TABLE "invoices" ADD COLUMN "owner_id" UUID REFERENCES "owners"("id") ON DELETE RESTRICT;
CREATE INDEX "invoices_owner_id_idx" ON "invoices" ("tenant_id", "owner_id") WHERE "owner_id" IS NOT NULL;

ALTER TABLE "invoice_series" ADD COLUMN "owner_id" UUID REFERENCES "owners"("id") ON DELETE RESTRICT;

-- Una cadena Veri*Factu por emisor: el número de la cadena es único por
-- tenant y emisor (antes por tenant).
DROP INDEX "invoices_tenant_chain_seq";
CREATE UNIQUE INDEX "invoices_tenant_chain_seq"
  ON "invoices" ("tenant_id", (COALESCE("owner_id", '00000000-0000-0000-0000-000000000000'::uuid)), "chain_seq")
  WHERE "chain_seq" IS NOT NULL;
