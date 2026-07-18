-- Datos de conexión del equipo para las ACCIONES SALIENTES (snapshot on-demand,
-- armar/desarmar la alarma). La ingesta de eventos no los usa (es un webhook
-- entrante). `control_url` = base del equipo/NVR (http://<ip>); el secreto
-- (user:pass) se cifra AES-256-GCM como en access_devices. Null = sin acciones
-- salientes configuradas (solo ingesta).
ALTER TABLE "camera_devices" ADD COLUMN "control_url" TEXT;
ALTER TABLE "camera_devices" ADD COLUMN "control_secret_encrypted" TEXT;
