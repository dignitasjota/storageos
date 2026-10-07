-- Soporte más ágil.
-- 1) Momento de la primera respuesta del equipo (no las notas internas).
ALTER TABLE "support_tickets" ADD COLUMN "first_response_at" TIMESTAMPTZ(6);

UPDATE "support_tickets" t
SET "first_response_at" = m.first_at
FROM (
  SELECT "ticket_id", MIN("created_at") AS first_at
  FROM "support_ticket_messages"
  WHERE "author_admin_id" IS NOT NULL AND "is_internal" = false
  GROUP BY "ticket_id"
) m
WHERE m."ticket_id" = t."id";

-- 2) Respuestas guardadas para las preguntas frecuentes (globales).
CREATE TABLE "support_canned_responses" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "support_canned_responses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_canned_responses_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
REVOKE ALL ON "support_canned_responses" FROM storageos_app;
