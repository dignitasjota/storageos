-- Cupones: opción «un uso por cliente».
ALTER TABLE "coupons" ADD COLUMN "once_per_customer" BOOLEAN NOT NULL DEFAULT false;
