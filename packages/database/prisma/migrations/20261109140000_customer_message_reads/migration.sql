-- Bandeja «Mensajes» con leído por usuario: hasta cuándo ha leído cada persona
-- del equipo la conversación con cada inquilino. `customer_messages.read_at`
-- sigue siendo el leído del equipo (lo usan los avisos para no repetirse) y el
-- del inquilino en el portal.
CREATE TABLE "customer_message_reads" (
  "customer_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "last_read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "customer_message_reads_pkey" PRIMARY KEY ("customer_id", "user_id"),
  CONSTRAINT "customer_message_reads_customer_id_fkey" FOREIGN KEY ("customer_id")
    REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_message_reads_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_message_reads_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_message_reads_tenant_user_idx" ON "customer_message_reads" ("tenant_id", "user_id");

ALTER TABLE "customer_message_reads" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "customer_message_reads";
CREATE POLICY tenant_isolation ON "customer_message_reads" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Lo que el equipo ya había leído queda leído para todos los usuarios actuales
-- (no se enciende el contador a nadie al desplegar).
INSERT INTO "customer_message_reads" ("customer_id", "user_id", "tenant_id", "last_read_at")
SELECT m."customer_id", u."id", m."tenant_id", max(m."created_at")
FROM "customer_messages" m
JOIN "users" u ON u."tenant_id" = m."tenant_id"
WHERE m."sender_type" = 'customer' AND m."read_at" IS NOT NULL
GROUP BY m."customer_id", u."id", m."tenant_id"
ON CONFLICT DO NOTHING;

-- Para la bandeja: el último mensaje de cada conversación.
CREATE INDEX IF NOT EXISTS "customer_messages_tenant_created_idx"
  ON "customer_messages" ("tenant_id", "created_at" DESC);
