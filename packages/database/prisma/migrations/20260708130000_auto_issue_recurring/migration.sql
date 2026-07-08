-- Emisión automática de las facturas recurrentes (opt-in por tenant). Si está
-- activo, la facturación recurrente emite directamente en vez de dejar el
-- borrador para revisión manual (elimina el cuello de botella del cierre mensual
-- con muchos contratos).
ALTER TABLE "tenants"
  ADD COLUMN "auto_issue_recurring" BOOLEAN NOT NULL DEFAULT false;
