-- Dominios propios: pausa por plan y vigilancia de los dominios activos.
--
-- `custom_domain_paused_verified_at`: mientras el plan del negocio no incluye
-- la función, `custom_domain_verified_at` se deja en NULL (todos los enlaces
-- vuelven a la plataforma) y aquí se guarda cuándo se activó, para
-- recuperarlo solo si la función vuelve.
-- `custom_domain_checked_at` / `_check_ok` / `_check_issue`: última
-- comprobación del dominio activo (DNS y HTTPS) para el panel y los avisos.
ALTER TABLE "tenants"
  ADD COLUMN "custom_domain_paused_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "custom_domain_checked_at" TIMESTAMPTZ(6),
  ADD COLUMN "custom_domain_check_ok" BOOLEAN,
  ADD COLUMN "custom_domain_check_issue" TEXT;
