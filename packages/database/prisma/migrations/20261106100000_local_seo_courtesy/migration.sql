-- Extra «SEO local»: las páginas de zona pasan de Web Premium a este extra.
-- Quien ya tiene alguna publicada la conserva: se le activa la función como
-- cortesía (sin fecha). Se puede quitar desde la ficha del tenant.
INSERT INTO tenant_feature_overrides (tenant_id, feature, enabled, source, created_at, updated_at)
SELECT DISTINCT p.tenant_id, 'local_seo', true, 'manual', now(), now()
FROM web_area_pages p
WHERE p.is_published
ON CONFLICT (tenant_id, feature) DO NOTHING;
