-- Tipo fiscal de cada línea de factura (códigos de Veri*Factu):
-- S1 = con IVA · E1-E6 = exenta (artículo de la Ley del IVA) · N1/N2 = no sujeta.
-- Hasta ahora toda línea al 0 % se declaraba como no sujeta (N1); el alquiler
-- de vivienda, por ejemplo, es exento (E1) y debe declararse así.
ALTER TABLE "invoice_items" ADD COLUMN "tax_category" TEXT NOT NULL DEFAULT 'S1';
UPDATE "invoice_items" SET "tax_category" = 'N1' WHERE "tax_rate" = 0;
