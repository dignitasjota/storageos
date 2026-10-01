-- IBAN al que los inquilinos pueden pagar por transferencia (aparece en el
-- correo de «Nueva factura» de quien no tiene domiciliación ni cobro
-- automático). Es un dato que el tenant publica en sus facturas: no se cifra.
ALTER TABLE "tenants" ADD COLUMN "transfer_iban" TEXT;
