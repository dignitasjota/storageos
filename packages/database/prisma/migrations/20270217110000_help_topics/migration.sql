-- Guías de «Cómo funciona» editables desde el panel de administración.
-- Las guías del código siguen siendo la base: una fila con el id de una guía
-- del código la cambia (contenido, imagen o vídeo, orden) o la oculta; una
-- fila con otro id es una guía nueva. Tabla global (sin tenant).
CREATE TABLE "platform_help_topics" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- Ancla de la guía (`/help#<topic_id>`).
  "topic_id" TEXT NOT NULL,
  -- Contenido: con título, la fila manda en todo el contenido; sin título,
  -- es una guía del código y se usa el suyo.
  "group" TEXT,
  "title" TEXT,
  "summary" TEXT,
  "steps" JSONB,
  "links" JSONB,
  "keywords" TEXT,
  "feature" TEXT,
  -- Imagen en el bucket público (`platform/help/`) o vídeo de YouTube/Vimeo.
  "image_key" TEXT,
  "video_url" TEXT,
  -- Orden dentro de su grupo; null = el del código.
  "position" INTEGER,
  "published" BOOLEAN NOT NULL DEFAULT true,
  -- Oculta una guía del código.
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_help_topics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_help_topics_topic_id_key" ON "platform_help_topics"("topic_id");
REVOKE ALL ON "platform_help_topics" FROM storageos_app;
