-- Layer B: plantillas WhatsApp Business (WABA) aprobadas para envíos proactivos.

-- message_templates: mapeo a la plantilla aprobada en Meta + orden de variables.
ALTER TABLE "message_templates"
  ADD COLUMN "whatsapp_template_name" TEXT,
  ADD COLUMN "whatsapp_template_language" TEXT,
  ADD COLUMN "whatsapp_template_variables" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- communications: snapshot de la plantilla WABA + parámetros posicionales resueltos.
ALTER TABLE "communications"
  ADD COLUMN "whatsapp_template_name" TEXT,
  ADD COLUMN "whatsapp_template_language" TEXT,
  ADD COLUMN "whatsapp_template_params" JSONB;
