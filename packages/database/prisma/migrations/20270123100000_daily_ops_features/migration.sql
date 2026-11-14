-- Operaciones diarias: mejoras.

-- Tareas: fotos y documentos ({id, key, mimeType, filename, createdAt}).
ALTER TABLE "tasks" ADD COLUMN "photos" JSONB NOT NULL DEFAULT '[]';

-- Mantenimiento: antelación, coste previsto y proveedor.
ALTER TABLE "maintenance_plans"
  ADD COLUMN "lead_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "estimated_cost" DECIMAL(12, 2),
  ADD COLUMN "supplier_id" UUID;
ALTER TABLE "maintenance_plans"
  ADD CONSTRAINT "maintenance_plans_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "expense_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Hasta ahora «cada N» no contaba en los semanales: siguen siendo cada semana.
UPDATE "maintenance_plans" SET "interval" = 1 WHERE "freq" = 'weekly' AND "interval" <> 1;

-- Incidencias: tipo, fotos, plazo de respuesta, coste y parte al seguro.
ALTER TABLE "incidents"
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other',
  ADD COLUMN "photos" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "response_due_at" TIMESTAMPTZ(6),
  ADD COLUMN "first_response_at" TIMESTAMPTZ(6),
  ADD COLUMN "cost" DECIMAL(12, 2),
  ADD COLUMN "expense_id" UUID,
  ADD COLUMN "insurance_claim_status" TEXT,
  ADD COLUMN "insurance_claim_ref" TEXT,
  ADD COLUMN "insurance_claim_amount" DECIMAL(12, 2);
ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_expense_id_fkey"
  FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Las abiertas que ya se están mirando cuentan como respondidas.
UPDATE "incidents" SET "first_response_at" = "updated_at"
  WHERE "status" <> 'reported' AND "first_response_at" IS NULL;
CREATE INDEX "incidents_tenant_response_idx" ON "incidents" ("tenant_id", "response_due_at")
  WHERE "first_response_at" IS NULL AND "deleted_at" IS NULL;

-- Plazos de la primera respuesta por gravedad (horas); null = los de serie.
ALTER TABLE "tenants" ADD COLUMN "incident_response_hours" JSONB;

-- Vencimientos: documentos ({id, key, mimeType, filename, createdAt}).
ALTER TABLE "business_reminders" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
