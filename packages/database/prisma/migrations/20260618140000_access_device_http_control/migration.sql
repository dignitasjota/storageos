-- Provider HTTP de cerraduras: URL del controlador + secreto HMAC cifrado.
ALTER TABLE "access_devices" ADD COLUMN "control_url" TEXT;
ALTER TABLE "access_devices" ADD COLUMN "control_secret_encrypted" TEXT;
