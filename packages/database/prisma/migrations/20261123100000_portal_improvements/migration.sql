-- Mejoras del área de clientes.

-- Cambio de trastero en autoservicio: el trastero que elige y desde cuándo.
ALTER TABLE "unit_change_requests"
  ADD COLUMN "target_unit_id" UUID REFERENCES "units"("id") ON DELETE SET NULL,
  ADD COLUMN "desired_date" DATE;

-- Preferencia de no recibir avisos por WhatsApp.
ALTER TABLE "customers" ADD COLUMN "whatsapp_opt_out_at" TIMESTAMPTZ(6);

-- Pagar varias facturas en un solo pago de Redsys (tarjeta o Bizum).
ALTER TABLE "redsys_orders" ADD COLUMN "extra_invoice_ids" UUID[] NOT NULL DEFAULT '{}';
