-- Oferta fundador de la web de TrasterOS (sección de precios), editable desde
-- el panel admin. Un único registro; desactivada por defecto.
CREATE TABLE "platform_founder_offer" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "title" TEXT NOT NULL DEFAULT 'Oferta fundador',
  "text" TEXT NOT NULL DEFAULT 'Los primeros 15 operadores: −40% para siempre + puesta en marcha y migración de datos gratis (valor 490€). Plazas limitadas.',
  "setup_strike" TEXT NOT NULL DEFAULT '490€',
  "setup_text" TEXT NOT NULL DEFAULT 'Puesta en marcha y migración de tus datos: gratis mientras dure la oferta.',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_founder_offer_pkey" PRIMARY KEY ("id")
);
INSERT INTO "platform_founder_offer" ("enabled") VALUES (false);

-- Tabla global: solo la conexión de administración.
REVOKE ALL ON "platform_founder_offer" FROM storageos_app;
