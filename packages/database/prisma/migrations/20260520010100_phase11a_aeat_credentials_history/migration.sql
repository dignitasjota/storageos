-- Fase 11A.2: histórico de credenciales AEAT del tenant.
--
-- Hasta ahora `tenant_aeat_credentials` tenía UNIQUE en `tenant_id` (una
-- sola fila por tenant; los uploads sobreescribían la anterior). Eso
-- impedía conservar trazabilidad de las rotaciones. Quitamos el UNIQUE y
-- dejamos un índice no-único compuesto `(tenant_id, revoked_at)` para
-- acelerar la consulta de "credencial activa" (WHERE revoked_at IS NULL)
-- y el listado de histórico. La "credencial activa" pasa a definirse a
-- nivel aplicación: filtramos por `revoked_at IS NULL` y, defensivamente,
-- ordenamos por `uploaded_at DESC`.

DROP INDEX IF EXISTS "tenant_aeat_credentials_tenant_id_key";

DROP INDEX IF EXISTS "tenant_aeat_credentials_tenant_id_revoked_at_idx";

CREATE INDEX IF NOT EXISTS "tenant_aeat_credentials_tenant_id_active_idx"
    ON "tenant_aeat_credentials" ("tenant_id", "revoked_at");
