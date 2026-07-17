-- Marca/fabricante del equipo de cámara/alarma, resuelto POR DEVICE (igual que
-- `access_devices.provider`). Hoy la INGESTA de eventos es agnóstica del origen
-- (webhook normalizado), así que este campo NO se usa aún; queda preparado para
-- las ACCIONES SALIENTES futuras (snapshot on-demand, armar/desarmar alarma) que
-- sí necesitan hablar la API específica del fabricante. Default 'dahua' (la única
-- marca integrada por ahora).
ALTER TABLE "camera_devices" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'dahua';
