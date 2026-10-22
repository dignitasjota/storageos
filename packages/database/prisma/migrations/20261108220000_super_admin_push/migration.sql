-- Avisos push para el super admin (panel admin instalado como app). Tabla
-- global: el super admin no pertenece a ningún tenant.
CREATE TABLE "super_admin_push_subscriptions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "super_admin_id" UUID NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "super_admin_push_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "super_admin_push_subscriptions_super_admin_id_fkey"
    FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "super_admin_push_subscriptions_endpoint_key"
  ON "super_admin_push_subscriptions" ("endpoint");
CREATE INDEX "super_admin_push_subscriptions_super_admin_id_idx"
  ON "super_admin_push_subscriptions" ("super_admin_id");

-- Tabla global: fuera del alcance del rol de la app (como el resto de las del admin).
REVOKE ALL ON "super_admin_push_subscriptions" FROM storageos_app;

-- Cuándo se envió por push cada aviso del feed. Lo que ya existe se da por
-- enviado para no mandar de golpe todo lo antiguo al activar los avisos.
ALTER TABLE "super_admin_notifications" ADD COLUMN "pushed_at" TIMESTAMPTZ(6);
UPDATE "super_admin_notifications" SET "pushed_at" = "created_at";
CREATE INDEX "super_admin_notifications_pending_push_idx"
  ON "super_admin_notifications" ("created_at") WHERE "pushed_at" IS NULL;
