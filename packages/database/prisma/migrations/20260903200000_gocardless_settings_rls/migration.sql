-- `gocardless_settings` se creó (20260629140000) sin el bloque de RLS que sí
-- llevan sus tablas hermanas `redsys_settings`/`holded_settings` (mismo tipo
-- de dato: access token/secreto por tenant cifrado, leído por
-- `GoCardlessSettingsService` vía `PrismaService.withTenant()`, la conexión
-- de tenant sometida a RLS). Sin esta policy, la RLS deja de ser el backstop
-- que documenta `PrismaService` ("si olvidas el filtro por tenant, 0 filas en
-- vez de fuga") para esta tabla en concreto — cierra el hueco alineándola con
-- el resto de tablas de credenciales de pasarela.
ALTER TABLE "gocardless_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gocardless_settings";
CREATE POLICY tenant_isolation ON "gocardless_settings"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
