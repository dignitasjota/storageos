-- Mejoras de Cartera: excepciones y % de actualización por contrato, plantilla
-- del aviso de subida y ofertas de renovación firmadas como anexo.

ALTER TABLE "contracts"
  ADD COLUMN "rent_increase_exempt_until" DATE,
  ADD COLUMN "rent_increase_exempt_reason" TEXT,
  ADD COLUMN "anniversary_update_pct" DECIMAL(5,2);

ALTER TABLE "tenants"
  ADD COLUMN "rent_increase_notice_template" JSONB;

-- Lo que hace un anexo al firmarse (p. ej. renovar el contrato).
ALTER TABLE "contract_annexes"
  ADD COLUMN "action" JSONB,
  ADD COLUMN "action_applied_at" TIMESTAMPTZ(6),
  ADD COLUMN "action_error" TEXT;
