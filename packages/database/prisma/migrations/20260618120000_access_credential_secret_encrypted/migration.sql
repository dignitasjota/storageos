-- Acceso del inquilino por QR/PIN: copia cifrada (AES-256-GCM) del secreto
-- para poder mostrárselo de nuevo en su portal (el hash no es reversible).
ALTER TABLE "access_credentials" ADD COLUMN "secret_encrypted" TEXT;
