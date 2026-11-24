-- Comerciales: los perdidos que ya llevaban los comerciales (archivados sin
-- fecha al desplegar la recuperación) reciben su fecha de volver a intentarlo
-- según su motivo, contando desde que se perdieron (decisión de Jota). Si esa
-- fecha ya pasó, salen en «Para recuperar» desde el primer día.

WITH months AS (
  SELECT COALESCE(
    (SELECT recover_months FROM platform_sales_settings ORDER BY id LIMIT 1),
    '{"not_now":6,"price":12,"competitor":12,"no_response":3,"own_software":12,"missing_feature":12,"no_conversion":12,"churned":12,"other":12}'::jsonb
  ) AS m
)
UPDATE platform_leads l
SET sales_recover_on = (
  (COALESCE(l.lost_at, l.sales_archived_at) AT TIME ZONE 'Europe/Madrid')::date
  + make_interval(months => COALESCE((months.m ->> COALESCE(l.lost_reason_code, 'other'))::int, 12))
)::date
FROM months
WHERE l.sales_rep_id IS NOT NULL
  AND l.status = 'lost'
  AND l.discarded_at IS NULL
  AND l.sales_archived_at IS NOT NULL
  AND l.sales_recover_on IS NULL
  AND l.do_not_contact = false;

-- Su constancia de archivado, como los que se archivan desde la app.
INSERT INTO sales_recoveries (lead_id, rep_id, tenant_id, kind, reason_code, archived_at, recover_on)
SELECT l.id, l.sales_rep_id, l.tenant_id,
       CASE WHEN l.tenant_id IS NOT NULL THEN 'client' ELSE 'prospect' END,
       l.lost_reason_code, l.sales_archived_at, l.sales_recover_on
FROM platform_leads l
WHERE l.sales_rep_id IS NOT NULL
  AND l.status = 'lost'
  AND l.discarded_at IS NULL
  AND l.sales_archived_at IS NOT NULL
  AND l.sales_recover_on IS NOT NULL
  AND l.do_not_contact = false
  AND NOT EXISTS (
    SELECT 1 FROM sales_recoveries r WHERE r.lead_id = l.id AND r.recovered_at IS NULL
  );
