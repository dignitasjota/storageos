-- Reconocimiento facial ("tu cara es la llave"). Feature/add-on facial_access.
-- Nuevo método de acceso + referencia a la foto (en MinIO, bucket privado). La
-- plantilla facial vive en el terminal (sync Patrón B vía FaceInfoManager); en
-- nuestra BD solo guardamos la key de la foto para poder re-sincronizarla.
ALTER TYPE "access_method" ADD VALUE IF NOT EXISTS 'face';
ALTER TABLE "access_credentials" ADD COLUMN "face_photo_key" TEXT;
