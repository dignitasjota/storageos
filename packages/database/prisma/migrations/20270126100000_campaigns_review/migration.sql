-- Revisión de Campañas y Comunicaciones.

-- Locales de quien creó la campaña (vacío = de toda la empresa): solo escribe
-- a los inquilinos y contactos de esos locales.
ALTER TABLE "campaigns" ADD COLUMN "facility_scope" UUID[] NOT NULL DEFAULT '{}';

-- Resultados guardados antes de que la limpieza borre los envíos.
ALTER TABLE "campaigns" ADD COLUMN "results_snapshot" JSONB;

-- El win-back reservaba el envío antes de prepararlo: con una variable mal
-- escrita marcaba al ex-cliente como avisado sin escribirle. Se liberan las
-- reservas recientes que no tienen correo.
DELETE FROM "winback_sends" ws
WHERE ws."sent_at" > now() - interval '90 days'
  AND NOT EXISTS (
    SELECT 1 FROM "communications" c
    WHERE c."tenant_id" = ws."tenant_id"
      AND c."customer_id" = ws."customer_id"
      AND c."source" = CASE WHEN ws."step" = 2 THEN 'winback.second' ELSE 'winback.auto' END
  );

-- Los enlaces con un código de acceso (firmar un contrato, una domiciliación,
-- descargar una factura…) ya no se guardan a la vista en el historial. Se
-- tapan en los envíos que ya salieron.
UPDATE "communications"
SET
  "body_text" = regexp_replace(
    "body_text",
    '(/(sign/annex|sign|sepa-mandate|review|waitlist-confirm|public/invoices)/|[?&;]token=)[A-Za-z0-9._~-]{16,}',
    '\1••••',
    'g'
  ),
  "body_html" = CASE
    WHEN "body_html" IS NULL THEN NULL
    ELSE regexp_replace(
      "body_html",
      '(/(sign/annex|sign|sepa-mandate|review|waitlist-confirm|public/invoices)/|[?&;]token=)[A-Za-z0-9._~-]{16,}',
      '\1••••',
      'g'
    )
  END
WHERE "status" NOT IN ('pending', 'processing')
  AND (
    "body_text" ~ '(/(sign/annex|sign|sepa-mandate|review|waitlist-confirm|public/invoices)/|[?&;]token=)[A-Za-z0-9._~-]{16,}'
    OR "body_html" ~ '(/(sign/annex|sign|sepa-mandate|review|waitlist-confirm|public/invoices)/|[?&;]token=)[A-Za-z0-9._~-]{16,}'
  );
