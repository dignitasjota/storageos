-- Interacciones manuales con el inquilino (llamadas, visitas, notas de lo
-- hablado): complementan el outbox de `communications` (envíos salientes) para
-- tener el histórico completo de "todo lo que hemos hablado" con un cliente.
CREATE TABLE "customer_interactions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "user_id" UUID,
    "type" TEXT NOT NULL DEFAULT 'note',
    "content" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "customer_interactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_interactions_tenant_id_idx"
    ON "customer_interactions" ("tenant_id");
CREATE INDEX "customer_interactions_customer_idx"
    ON "customer_interactions" ("tenant_id", "customer_id");

ALTER TABLE "customer_interactions"
    ADD CONSTRAINT "customer_interactions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_interactions"
    ADD CONSTRAINT "customer_interactions_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_interactions"
    ADD CONSTRAINT "customer_interactions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_interactions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "customer_interactions";
CREATE POLICY tenant_isolation ON "customer_interactions" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
