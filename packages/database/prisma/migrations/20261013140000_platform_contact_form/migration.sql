-- Formulario de contacto de la web de TrasterOS, configurable desde el panel
-- admin: a qué email llega, textos y qué campos opcionales se piden.
ALTER TABLE "platform_website"
  ADD COLUMN "contact_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "contact_title" TEXT NOT NULL DEFAULT '¿Hablamos?',
  ADD COLUMN "contact_subtitle" TEXT NOT NULL DEFAULT 'Cuéntanos tu caso y te respondemos en menos de 24 horas laborables.',
  ADD COLUMN "contact_show_phone" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "contact_require_phone" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contact_show_company" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "contact_show_units" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "contact_show_profile" BOOLEAN NOT NULL DEFAULT true;

-- Mensajes recibidos (también si el correo falla, para no perder ninguno).
CREATE TABLE "platform_contact_messages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "company" TEXT,
  "units" TEXT,
  "profile" TEXT,
  "message" TEXT NOT NULL,
  "ip_address" TEXT,
  "email_sent" BOOLEAN NOT NULL DEFAULT false,
  "handled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_contact_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_contact_messages_created_idx" ON "platform_contact_messages" ("created_at" DESC);

-- Tabla global: solo la conexión de administración.
REVOKE ALL ON "platform_contact_messages" FROM storageos_app;
