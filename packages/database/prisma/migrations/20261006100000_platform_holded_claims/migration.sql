-- Copia en Holded de las facturas de suscripción sin duplicados y con
-- rectificativas (mismo patrón que la copia de las facturas de los tenants).
--
-- platform_invoices.holded_sync_state: NULL = nada en curso | 'creating' =
--   reservada, llamando a Holded | 'approving' = creada (id guardado), falta
--   aprobarla. holded_sync_started_at: cuándo se reservó. Si Holded no responde
--   la reserva se queda y sale «para revisar» (pudo crearse).
-- holded_credit_note_id: en una rectificativa por sustitución, la rectificativa
--   de Holded que anula la factura original (la sustitutiva va aparte).
-- holded_payment_started_at / holded_payment_synced_at: reserva y copia del cobro.
ALTER TABLE "platform_invoices"
  ADD COLUMN "holded_sync_state" TEXT,
  ADD COLUMN "holded_sync_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "holded_credit_note_id" TEXT,
  ADD COLUMN "holded_payment_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "holded_payment_synced_at" TIMESTAMPTZ(6);

-- Las facturas ya copiadas se emitieron con su cobro.
UPDATE "platform_invoices"
  SET "holded_payment_synced_at" = "created_at"
  WHERE "holded_document_id" IS NOT NULL AND "invoice_type" = 'F1';

-- Serie de rectificativas de Holded (marcada «No enviar a Verifactu»).
ALTER TABLE "platform_billing_settings"
  ADD COLUMN "holded_credit_note_series_id" TEXT;
