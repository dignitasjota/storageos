-- URL de vídeo (YouTube/Vimeo) del local para la web pública. Se guarda tal
-- cual la pega el tenant; el frontend decide si sabe embeberla (formato
-- reconocido) o muestra un enlace "Ver vídeo" de respaldo.
ALTER TABLE "facilities" ADD COLUMN "video_url" TEXT;
