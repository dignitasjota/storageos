-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "invited_by_user_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invitations_tenant_id_idx" ON "invitations"("tenant_id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indice unico parcial: solo una invitacion pendiente por (tenant, email).
-- Prisma no soporta indices con WHERE en el schema (a fecha de Prisma 6),
-- asi que lo creamos a mano. Las invitaciones aceptadas o revocadas no
-- bloquean nuevas invitaciones al mismo email.
CREATE UNIQUE INDEX "invitations_tenant_email_pending_uq"
    ON "invitations" ("tenant_id", "email")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
