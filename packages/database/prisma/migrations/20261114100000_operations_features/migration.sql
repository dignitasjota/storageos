-- Funcionalidades de la Operativa: avisos para una persona, tareas automáticas,
-- señal de las reservas y autorizados de cada inquilino.

-- Aviso dirigido a un usuario (null = a todo el equipo que ve su local).
ALTER TABLE "notifications" ADD COLUMN "user_id" UUID;
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "notifications_tenant_user_idx" ON "notifications"("tenant_id", "user_id");

-- Reglas de tareas automáticas (bienvenida, revisión tras la salida, renovación).
ALTER TABLE "tenants" ADD COLUMN "task_auto_rules" JSONB;

-- Señal de la reserva: factura cobrada y descuento pendiente en el contrato.
ALTER TABLE "reservations" ADD COLUMN "deposit_invoice_id" UUID;
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_deposit_invoice_id_fkey"
  FOREIGN KEY ("deposit_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "reservations_deposit_invoice_idx" ON "reservations"("deposit_invoice_id");

ALTER TABLE "contracts" ADD COLUMN "pending_credit_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "contracts" ADD COLUMN "pending_credit_reason" TEXT;

-- Personas autorizadas por el inquilino.
CREATE TABLE "customer_authorized_persons" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "full_name" TEXT NOT NULL,
  "document_number" TEXT,
  "phone" TEXT,
  "relationship" TEXT,
  "can_access" BOOLEAN NOT NULL DEFAULT true,
  "can_pickup" BOOLEAN NOT NULL DEFAULT false,
  "can_manage" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "customer_authorized_persons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_authorized_persons_customer_idx"
  ON "customer_authorized_persons"("tenant_id", "customer_id");
ALTER TABLE "customer_authorized_persons"
  ADD CONSTRAINT "customer_authorized_persons_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_authorized_persons"
  ADD CONSTRAINT "customer_authorized_persons_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_authorized_persons"
  ADD CONSTRAINT "customer_authorized_persons_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_authorized_persons" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_authorized_persons" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_authorized_persons" TO storageos_app;
