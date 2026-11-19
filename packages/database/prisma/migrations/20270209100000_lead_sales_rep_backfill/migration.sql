-- Leads creados o editados desde el panel admin y asignados a un comercial
-- antes de este arreglo: quedaban con «quien lo lleva» pero sin comercial, así
-- que no salían en su panel. Se ponen en su cartera (sin tocar los que ya
-- tienen comercial ni los descartados), se abre su asignación y, si ya tienen
-- cuenta sin comercial, la cuenta también pasa a ser suya.
WITH fixed AS (
  UPDATE "platform_leads" l
  SET "sales_rep_id" = l."assigned_to_id",
      "sales_assigned_at" = now()
  FROM "super_admins" s
  WHERE s."id" = l."assigned_to_id"
    AND s."role" = 'sales'
    AND s."is_active" = true
    AND l."sales_rep_id" IS NULL
    AND l."discarded_at" IS NULL
  RETURNING l."id", l."sales_rep_id", l."tenant_id"
),
assignments AS (
  INSERT INTO "sales_assignments" ("rep_id", "lead_id", "tenant_id", "source", "started_at")
  SELECT f."sales_rep_id", f."id", f."tenant_id", 'manual', now()
  FROM fixed f
)
UPDATE "tenants" t
SET "sales_rep_id" = f."sales_rep_id",
    "sales_assigned_at" = now(),
    "sales_source" = 'manual'
FROM fixed f
WHERE f."tenant_id" = t."id"
  AND t."sales_rep_id" IS NULL;
