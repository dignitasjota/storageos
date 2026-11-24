-- Comerciales: reparto masivo de prospectos desde la dirección.

-- Lote del reparto (p. ej. «Feria Valencia») para filtrar y medir resultados,
-- cuándo abrió el comercial el prospecto («Nuevo para ti» mientras sea null) y
-- cuándo se avisó a la dirección de que iba a quedar libre por inactividad.
ALTER TABLE platform_leads
  ADD COLUMN sales_batch TEXT,
  ADD COLUMN sales_seen_at TIMESTAMPTZ,
  ADD COLUMN sales_release_warned_at TIMESTAMPTZ;

-- Lo que ya llevaban los comerciales no es nuevo para ellos.
UPDATE platform_leads
SET sales_seen_at = COALESCE(sales_assigned_at, now())
WHERE sales_rep_id IS NOT NULL;

CREATE INDEX platform_leads_sales_batch_idx ON platform_leads (sales_batch)
  WHERE sales_batch IS NOT NULL;
CREATE INDEX platform_leads_sales_new_idx ON platform_leads (sales_rep_id)
  WHERE sales_rep_id IS NOT NULL AND sales_seen_at IS NULL;
