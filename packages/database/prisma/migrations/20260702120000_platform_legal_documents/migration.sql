-- Documentos legales de la plataforma (StorageOS), editables por el super admin.
-- Tabla global (sin tenant_id, sin RLS): son las condiciones del prestador del SaaS.
CREATE TABLE "platform_legal_documents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_legal_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_legal_documents_slug_key" ON "platform_legal_documents"("slug");
