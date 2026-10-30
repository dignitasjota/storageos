-- Landings de promoción: nueva estructura con bloques configurables. El
-- contenido se guarda en un JSON (`PromoLandingContent` en shared); los campos
-- sueltos anteriores (oferta, texto, ventajas, condiciones, botón y secciones)
-- se pasan a él y dejan de usarse (se conservan para no perder datos).
ALTER TABLE "promo_landings" ADD COLUMN "content" JSONB NOT NULL DEFAULT '{}';

UPDATE "promo_landings" SET "content" = jsonb_strip_nulls(jsonb_build_object(
  'hero', jsonb_build_object(
    'primaryCta', jsonb_build_object(
      'label', COALESCE(NULLIF(left("cta_label", 40), ''), 'Reservar ahora'),
      'action', 'book'
    )
  ),
  'offer', CASE WHEN COALESCE("offer_text", '') <> '' THEN jsonb_build_object(
    'enabled', true,
    'title', left("offer_text", 40),
    'highlight', left("offer_text", 120)
  ) END,
  'benefits', CASE WHEN cardinality("benefits") > 0 THEN jsonb_build_object(
    'enabled', true,
    'items', (
      SELECT jsonb_agg(jsonb_build_object('title', left(b, 60)))
      FROM (SELECT b FROM unnest("benefits") AS b LIMIT 6) AS x
    )
  ) END,
  'promotion', CASE WHEN COALESCE("body", '') <> '' THEN jsonb_build_object(
    'enabled', true,
    'panelTitle', left(COALESCE("offer_text", ''), 120),
    'panelText', left("body", 1000)
  ) END,
  'conditions', CASE WHEN COALESCE("conditions", '') <> '' THEN jsonb_build_object(
    'enabled', true,
    'items', (
      SELECT COALESCE(jsonb_agg(left(trim(l), 400)), '[]'::jsonb)
      FROM (
        SELECT l FROM regexp_split_to_table("conditions", E'\n') AS l
        WHERE trim(l) <> '' LIMIT 12
      ) AS y
    )
  ) END,
  'testimonials', jsonb_build_object('enabled', "show_testimonials"),
  'faq', jsonb_build_object('enabled', "show_faq"),
  'contact', jsonb_build_object('enabled', "show_contact")
));
