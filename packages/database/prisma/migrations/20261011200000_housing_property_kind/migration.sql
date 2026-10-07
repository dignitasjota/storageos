-- Add-on «Viviendas»: un tipo de unidad puede ser una vivienda. Su alquiler se
-- factura exento de IVA (art. 20.1.23.º LIVA) en vez de al 21 %.
ALTER TABLE "unit_types" ADD COLUMN "property_kind" TEXT NOT NULL DEFAULT 'storage';
