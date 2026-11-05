-- Orden y tarjetas visibles del Resumen, por usuario.
ALTER TABLE "users" ADD COLUMN "dashboard_layout" JSONB NOT NULL DEFAULT '{}';
