-- Ajustes de la web de TrasterOS (trasteros.pro), editables desde el panel
-- admin. Un único registro. logo_key = imagen en el bucket público (null = el
-- logo de la marca que trae la aplicación).
CREATE TABLE "platform_website" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "logo_key" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_website_pkey" PRIMARY KEY ("id")
);
INSERT INTO "platform_website" ("logo_key") VALUES (NULL);

-- Tabla global: solo la conexión de administración.
REVOKE ALL ON "platform_website" FROM storageos_app;
