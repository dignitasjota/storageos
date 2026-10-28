-- Oferta de preapertura: cupón que solo vale para reservas en un local que aún
-- no ha abierto.
ALTER TABLE "coupons"
  ADD COLUMN "pre_opening_only" BOOLEAN NOT NULL DEFAULT false;
