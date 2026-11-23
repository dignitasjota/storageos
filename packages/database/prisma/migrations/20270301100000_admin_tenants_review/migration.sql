-- Revisión del apartado Tenants del super admin.

-- Cerrar todas las sesiones de un usuario invalida también sus access tokens
-- (duran 15 minutos y no llevan la sesión): se rechazan los emitidos antes.
ALTER TABLE users ADD COLUMN tokens_valid_after TIMESTAMPTZ;
