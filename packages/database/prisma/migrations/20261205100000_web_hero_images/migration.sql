-- Fotos de la portada de la web pública del tenant (Web Premium): la entrada
-- del local y una foto del interior para el fondo difuminado. Claves del bucket
-- público (`<tenant>/web-hero/…`); null = la portada de siempre.
ALTER TABLE "tenants" ADD COLUMN "web_hero_image_key" TEXT;
ALTER TABLE "tenants" ADD COLUMN "web_hero_background_key" TEXT;
