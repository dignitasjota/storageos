-- Chat bidireccional inquilino (portal) <-> staff. Un hilo por cliente.
CREATE TABLE "customer_messages" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_user_id" UUID,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "customer_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_messages_tenant_id_idx" ON "customer_messages" ("tenant_id");
CREATE INDEX "customer_messages_thread_idx"
    ON "customer_messages" ("tenant_id", "customer_id", "created_at");

ALTER TABLE "customer_messages"
    ADD CONSTRAINT "customer_messages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_messages"
    ADD CONSTRAINT "customer_messages_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_messages"
    ADD CONSTRAINT "customer_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_messages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "customer_messages";
CREATE POLICY tenant_isolation ON "customer_messages" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
