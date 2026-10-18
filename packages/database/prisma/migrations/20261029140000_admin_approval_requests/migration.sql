-- Cola de aprobación: el rol soporte pide una acción sobre un tenant y un
-- super admin la aprueba (se ejecuta tal cual) o la rechaza.
CREATE TABLE "admin_approval_requests" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "requested_by_id" UUID,
  "action" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "admin_approval_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_approval_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_approval_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "admin_approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "admin_approval_requests_status_created_at_idx" ON "admin_approval_requests"("status", "created_at");
CREATE INDEX "admin_approval_requests_tenant_id_created_at_idx" ON "admin_approval_requests"("tenant_id", "created_at");

-- Tabla global: solo la conexión de administración.
REVOKE ALL ON "admin_approval_requests" FROM storageos_app;
