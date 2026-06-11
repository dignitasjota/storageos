-- Fase 12A.1: politica que fuerza 2FA TOTP para roles privilegiados
-- (owner/manager). Cuando el flag esta activo, esos roles no pueden emitir
-- access/refresh sin tener 2FA configurado: el login devuelve un
-- `enrolmentToken` y el frontend les redirige al setup obligatorio.
--
-- La columna se anade nullable=false con default=false para no romper
-- tenants existentes; activarla es decision del owner via
-- `PATCH /settings/tenant/security`.

ALTER TABLE tenants
  ADD COLUMN require_two_factor_for_managers BOOLEAN NOT NULL DEFAULT false;
