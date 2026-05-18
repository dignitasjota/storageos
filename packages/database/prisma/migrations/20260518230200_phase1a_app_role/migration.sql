-- Rol de aplicación: lectura/escritura de datos, sin DDL y SIN BYPASSRLS.
-- Se utiliza desde apps/api en lugar del usuario admin `storageos`.
--
-- Las migraciones, el seed y las operaciones administrativas se siguen
-- ejecutando como `storageos` (superuser), que sí bypassea las políticas
-- de Row-Level Security porque es OWNER de las tablas.
--
-- Las políticas RLS concretas se definen en la migración siguiente
-- (`phase1a_rls`).

-- Idempotente: la migración se puede aplicar varias veces (p. ej. tras un
-- `migrate reset`) sin error.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storageos_app') THEN
        CREATE ROLE storageos_app LOGIN PASSWORD 'storageos-app';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE storageos TO storageos_app;
GRANT USAGE ON SCHEMA public TO storageos_app;

-- Permisos sobre los objetos existentes en `public`.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO storageos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO storageos_app;

-- Permisos por defecto para los objetos que cree `storageos` en el futuro
-- (próximas migraciones). Sin esto, cada migración futura tendría que
-- repetir los GRANT manualmente.
ALTER DEFAULT PRIVILEGES FOR ROLE storageos IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO storageos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE storageos IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO storageos_app;

-- Función auxiliar usada por defaults de columnas.
GRANT EXECUTE ON FUNCTION uuid_generate_v7() TO storageos_app;

COMMENT ON ROLE storageos_app IS
    'Rol de aplicacion de StorageOS. Sin DDL, sin BYPASSRLS. Usado por apps/api.';
