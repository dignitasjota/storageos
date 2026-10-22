-- «Panel con tu marca» (`branded_panel`) entra en los planes Pro y
-- Administrador: el panel del equipo y su app instalada con el logo y el
-- nombre del tenant.
UPDATE "subscription_plans"
SET "tenant_features" = array_append("tenant_features", 'branded_panel')
WHERE "slug" IN ('pro', 'administrador')
  AND NOT ('branded_panel' = ANY ("tenant_features"));
