-- SEO web, fase 1 PR 5 (2026-11-30): subdominios de la plataforma (D4).
-- `subdomain_ready_at` marca que el subdominio `<slug>.trasteros.pro` ya está
-- creado en el proxy (certificado por subdominio, a mano desde el panel admin).
-- NULL = pendiente: aparece en la cola de dominios propios y en «Hoy».
-- Solo añade la columna; no cambia ningún dato.
ALTER TABLE "tenants" ADD COLUMN "subdomain_ready_at" TIMESTAMPTZ(6);
