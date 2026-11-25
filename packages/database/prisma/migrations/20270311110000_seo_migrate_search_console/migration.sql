-- SEO Avanzado: los tenants que ya tienen Search Console conectado (extra «SEO
-- local») pasan al modelo nuevo. Por cada uno: su proyecto, su dominio
-- principal y una copia de lo descargado (totales por día → cruce `site`, por
-- dispositivo → `device`, búsqueda y página → `query_page`). Los demás cruces
-- los rellena la carga inicial cuando el tenant tenga SEO Avanzado.
--
-- Las tablas antiguas NO se tocan: siguen alimentando «Posiciones en Google»
-- hasta que esas pantallas pasen al motor nuevo (PR aparte).
--
-- Va en una función para poder repetirla (solo copia los tenants que aún no
-- tienen proyecto) y probarla.

CREATE OR REPLACE FUNCTION seo_migrate_search_console() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  p_id UUID;
  d_id UUID;
  host TEXT;
  n INTEGER := 0;
BEGIN
  FOR r IN
    SELECT sc.*, t.name AS tenant_name
      FROM tenant_search_console sc
      JOIN tenants t ON t.id = sc.tenant_id
     WHERE t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM seo_projects p WHERE p.tenant_id = sc.tenant_id)
  LOOP
    host := lower(regexp_replace(
      regexp_replace(regexp_replace(r.site_url, '^sc-domain:', '', 'i'), '^https?://', '', 'i'),
      '[/:?#].*$', ''));
    host := regexp_replace(regexp_replace(host, '^www\.', ''), '\.$', '');

    INSERT INTO seo_projects (tenant_id, name, brand_terms)
    VALUES (r.tenant_id, r.tenant_name, r.brand_terms)
    RETURNING id INTO p_id;

    INSERT INTO seo_project_domains (
      tenant_id, project_id, domain, role, gsc_property, connection_status, last_error,
      checked_at, connected_at, last_synced_at
    ) VALUES (
      r.tenant_id, p_id, host, 'primary', r.site_url,
      CASE r.status WHEN 'connected' THEN 'connected' WHEN 'error' THEN 'error' ELSE 'pending' END,
      r.last_error, r.updated_at, r.connected_at, r.last_synced_at
    )
    RETURNING id INTO d_id;

    INSERT INTO seo_gsc_metrics (tenant_id, domain_id, grain, date, clicks, impressions, ctr, position)
    SELECT r.tenant_id, d_id, 'site', d.date, d.clicks, d.impressions,
           CASE WHEN d.impressions > 0 THEN round(d.clicks::numeric / d.impressions, 6) ELSE 0 END,
           d.position
      FROM search_console_days d
     WHERE d.tenant_id = r.tenant_id
    ON CONFLICT DO NOTHING;

    INSERT INTO seo_gsc_metrics (tenant_id, domain_id, grain, date, device, clicks, impressions, ctr, position)
    SELECT r.tenant_id, d_id, 'device', d.date, d.device, d.clicks, d.impressions,
           CASE WHEN d.impressions > 0 THEN round(d.clicks::numeric / d.impressions, 6) ELSE 0 END,
           d.position
      FROM search_console_devices d
     WHERE d.tenant_id = r.tenant_id
    ON CONFLICT DO NOTHING;

    INSERT INTO seo_gsc_metrics (tenant_id, domain_id, grain, date, query, page, clicks, impressions, ctr, position)
    SELECT r.tenant_id, d_id, 'query_page', q.date, q.query, q.page, q.clicks, q.impressions,
           CASE WHEN q.impressions > 0 THEN round(q.clicks::numeric / q.impressions, 6) ELSE 0 END,
           q.position
      FROM search_console_rows q
     WHERE q.tenant_id = r.tenant_id
    ON CONFLICT DO NOTHING;

    UPDATE seo_project_domains
       SET data_until = (
         SELECT max(date) FROM seo_gsc_metrics WHERE domain_id = d_id AND grain = 'site'
       )
     WHERE id = d_id;

    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION seo_migrate_search_console() FROM PUBLIC;

SELECT seo_migrate_search_console();
