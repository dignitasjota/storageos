-- AlterTable
ALTER TABLE "super_admins" ADD COLUMN     "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "two_factor_enrolled_at" TIMESTAMPTZ(6),
ADD COLUMN     "two_factor_pending_secret" TEXT,
ADD COLUMN     "two_factor_secret" TEXT;

-- CreateTable
CREATE TABLE "super_admin_recovery_codes" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "super_admin_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "super_admin_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_admin_sessions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "super_admin_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "replaced_by_session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "super_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "super_admin_recovery_codes_super_admin_id_idx" ON "super_admin_recovery_codes"("super_admin_id");

-- CreateIndex
CREATE INDEX "super_admin_sessions_super_admin_id_idx" ON "super_admin_sessions"("super_admin_id");

-- CreateIndex
CREATE INDEX "super_admin_sessions_expires_at_idx" ON "super_admin_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "super_admin_recovery_codes" ADD CONSTRAINT "super_admin_recovery_codes_super_admin_id_fkey" FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_admin_sessions" ADD CONSTRAINT "super_admin_sessions_super_admin_id_fkey" FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

