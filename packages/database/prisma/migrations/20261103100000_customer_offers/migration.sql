-- Propuestas al inquilino (desde Oportunidades): se enseñan en su área de
-- clientes con «Me interesa / No, gracias» y se dan por aceptadas cuando
-- contrata lo propuesto. Nunca se aplica nada solo.
CREATE TABLE "customer_offers" (
    "id"           UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id"    UUID NOT NULL,
    "customer_id"  UUID NOT NULL,
    -- insurance | larger_unit | additional_unit | night_pass | autopay
    "kind"         TEXT NOT NULL,
    "title"        TEXT NOT NULL,
    "message"      TEXT NOT NULL,
    "price_gross"  DECIMAL(10, 2),
    -- open | interested | declined | accepted | expired
    "status"       TEXT NOT NULL DEFAULT 'open',
    "seen_at"      TIMESTAMPTZ(6),
    "responded_at" TIMESTAMPTZ(6),
    "accepted_at"  TIMESTAMPTZ(6),
    "expires_at"   TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "customer_offers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_offers_tenant_customer_idx"
    ON "customer_offers" ("tenant_id", "customer_id", "created_at" DESC);

ALTER TABLE "customer_offers" ADD CONSTRAINT "customer_offers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_offers" ADD CONSTRAINT "customer_offers_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_offers" ADD CONSTRAINT "customer_offers_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_offers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "customer_offers";
CREATE POLICY tenant_isolation ON "customer_offers" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
