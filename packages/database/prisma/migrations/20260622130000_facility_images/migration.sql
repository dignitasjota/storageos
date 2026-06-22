-- Crecimiento/CRM: imágenes del local para la landing pública.
--
-- `images` guarda las KEYS de objeto en MinIO (no URLs del cliente). El
-- servidor construye las URLs públicas con `FilesService.buildPublicUrl`.

ALTER TABLE "facilities" ADD COLUMN "images" TEXT[] NOT NULL DEFAULT '{}';
