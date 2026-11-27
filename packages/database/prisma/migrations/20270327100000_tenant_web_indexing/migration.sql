-- SEO web, fase 1 PR 2 (2026-11-27): control de indexación por tenant (D3).
-- `auto` (por defecto) aplica la regla; `on` fuerza indexable; `off` noindex y fuera del sitemap.
-- Solo añade la columna: ningún tenant cambia de valor, todos quedan en `auto`.
ALTER TABLE "tenants" ADD COLUMN "web_indexing" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_web_indexing_check"
  CHECK ("web_indexing" IN ('auto', 'on', 'off'));
