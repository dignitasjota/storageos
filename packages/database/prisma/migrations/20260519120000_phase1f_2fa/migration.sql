-- Fase 1F: 2FA TOTP + recovery codes.
-- - `users.two_factor_pending_secret`: secret cifrado durante el flujo de
--   setup (entre /auth/2fa/setup y /auth/2fa/verify). Tras verify, se mueve
--   a `two_factor_secret` y se pone a NULL.
-- - `recovery_codes`: 10 codigos por user al activar 2FA, hash argon2id,
--   single-use (`used_at`).

ALTER TABLE "users"
    ADD COLUMN "two_factor_pending_secret" text;

CREATE TABLE "recovery_codes" (
    "id"         uuid          PRIMARY KEY DEFAULT uuid_generate_v7(),
    "tenant_id"  uuid          NOT NULL,
    "user_id"    uuid          NOT NULL,
    "code_hash"  text          NOT NULL,
    "used_at"    timestamptz(6),
    "created_at" timestamptz(6) NOT NULL DEFAULT now()
);

ALTER TABLE "recovery_codes"
    ADD CONSTRAINT "recovery_codes_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "recovery_codes_tenant_id_idx" ON "recovery_codes" ("tenant_id");
CREATE INDEX "recovery_codes_user_id_used_at_idx" ON "recovery_codes" ("user_id", "used_at");
