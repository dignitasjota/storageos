-- Medidas opcionales de los trasteros de la competencia. Cuando se conocen el
-- ancho y el fondo, el área (area_m2) se calcula en el servicio; la altura es
-- informativa (volumen). Nullable: no siempre se dispone de las medidas.
ALTER TABLE "competitor_units"
  ADD COLUMN "width_m" DECIMAL(10,2),
  ADD COLUMN "depth_m" DECIMAL(10,2),
  ADD COLUMN "height_m" DECIMAL(10,2);

-- ¿Los precios de sus trasteros incluyen IVA? Algunos competidores lo muestran
-- con IVA y otros sin él → se marca por competidor para normalizar a NETO al
-- comparar con nuestros precios (sin IVA). Default true (lo habitual de cara al público).
ALTER TABLE "competitor_facilities"
  ADD COLUMN "price_includes_vat" BOOLEAN NOT NULL DEFAULT true;
