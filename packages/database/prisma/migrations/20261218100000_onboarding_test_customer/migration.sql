-- Inquilino de prueba de la puesta en marcha: no factura ni cuenta como cliente.
ALTER TABLE "customers" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;
