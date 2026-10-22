-- Mensajes de TrasterOS al tenant (correo directo, anuncios, retención): quedan
-- también en su panel (Soporte → Mensajes de TrasterOS), no solo en su buzón.
-- El correo directo abre además un ticket para poder responderlo desde el panel.
CREATE TABLE "tenant_platform_messages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "ticket_id" UUID,
  "super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_platform_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_platform_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_platform_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id")
    REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tenant_platform_messages_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "tenant_platform_messages_tenant_created_idx"
  ON "tenant_platform_messages" ("tenant_id", "created_at" DESC);

ALTER TABLE "tenant_platform_messages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_platform_messages";
CREATE POLICY tenant_isolation ON "tenant_platform_messages" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
