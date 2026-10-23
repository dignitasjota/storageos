-- Bloqueo de la app del panel en el móvil: tras 15 min sin uso se abre con
-- Face ID / huella (llave de acceso, WebAuthn) o con un PIN de respaldo.

ALTER TABLE "users"
  ADD COLUMN "app_pin_hash" TEXT,
  ADD COLUMN "app_pin_failed_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "webauthn_challenge" TEXT,
  ADD COLUMN "webauthn_challenge_expires_at" TIMESTAMPTZ(6);

CREATE TABLE "user_passkeys" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "credential_id" TEXT NOT NULL,
  "public_key" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "label" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_used_at" TIMESTAMPTZ(6),
  CONSTRAINT "user_passkeys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_passkeys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "user_passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "user_passkeys_credential_id_key" ON "user_passkeys" ("credential_id");
CREATE INDEX "user_passkeys_user_idx" ON "user_passkeys" ("tenant_id", "user_id");

ALTER TABLE "user_passkeys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_passkeys" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
