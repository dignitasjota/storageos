-- CreateTable: histórico de conversaciones/interacciones del super admin con un tenant.
-- Replica `customer_interactions` pero el autor es un super admin (super_admin_id).
CREATE TABLE "tenant_interactions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "super_admin_id" UUID,
    "type" TEXT NOT NULL DEFAULT 'note',
    "content" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tenant_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_interactions_tenant_id_idx" ON "tenant_interactions" ("tenant_id");
CREATE INDEX "tenant_interactions_tenant_occurred_idx" ON "tenant_interactions" ("tenant_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "tenant_interactions"
    ADD CONSTRAINT "tenant_interactions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_interactions"
    ADD CONSTRAINT "tenant_interactions_super_admin_id_fkey"
    FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: aislamiento por tenant (coherencia/defensa; el panel admin la consume
-- vía la conexión admin que bypassa RLS, igual que tenant_subscription_payments).
ALTER TABLE "tenant_interactions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_interactions";
CREATE POLICY tenant_isolation ON "tenant_interactions" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
