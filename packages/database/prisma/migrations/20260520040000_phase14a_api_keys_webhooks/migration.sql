-- Fase 14A.3: API keys (Bearer alternativo) + webhooks salientes con HMAC.
--
-- `api_keys`: tokens de larga duracion `sk_live_<tenantId>.<secret>` con
-- hash argon2id del secret. Plaintext devuelto una sola vez al crear.
-- `webhooks`: URLs registradas por el tenant para recibir eventos via POST
-- firmado HMAC SHA-256. `secret` cifrado AES-256-GCM por CryptoService.
-- `webhook_deliveries`: audit trail por intento (retry exponencial BullMQ).

-- CreateTable: api_keys
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_revoked_at_idx" ON "api_keys"("tenant_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_keys"
    ADD CONSTRAINT "api_keys_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: webhooks
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhooks_tenant_id_is_active_idx" ON "webhooks"("tenant_id", "is_active");

-- AddForeignKey
ALTER TABLE "webhooks"
    ADD CONSTRAINT "webhooks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: webhook_deliveries
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "status_code" INTEGER,
    "response_body" TEXT,
    "error_message" TEXT,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_status_idx" ON "webhook_deliveries"("tenant_id", "status");
CREATE INDEX "webhook_deliveries_webhook_id_created_at_idx" ON "webhook_deliveries"("webhook_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey"
    FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: aislamiento por tenant_id usando el contexto de sesion.
-- (Los permisos al rol storageos_app vienen de ALTER DEFAULT PRIVILEGES
-- definido en 20260518230200_phase1a_app_role.)

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "api_keys";
CREATE POLICY tenant_isolation ON "api_keys"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "webhooks";
CREATE POLICY tenant_isolation ON "webhooks"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "webhook_deliveries";
CREATE POLICY tenant_isolation ON "webhook_deliveries"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
