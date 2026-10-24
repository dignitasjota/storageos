-- Sesión del panel abierta desde la app instalada en el móvil: dura 90 días
-- (renovándose al usarla) en vez de 7. Las nuevas sesiones que salen de ella
-- al renovar lo heredan.
ALTER TABLE "sessions" ADD COLUMN "installed_app" BOOLEAN NOT NULL DEFAULT false;
