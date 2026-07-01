-- Notificaciones del super admin (feed de eventos de plataforma) + banner global
-- que se muestra a todos los tenants en su panel. Tablas globales.

CREATE TABLE "super_admin_notifications" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "super_admin_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "super_admin_notifications_created_idx" ON "super_admin_notifications" ("created_at" DESC);

-- Banner global (singleton). Se muestra a todos los tenants si está activo.
CREATE TABLE "platform_banner" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "message" TEXT NOT NULL DEFAULT '',
    "level" TEXT NOT NULL DEFAULT 'info',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_banner_pkey" PRIMARY KEY ("id")
);
