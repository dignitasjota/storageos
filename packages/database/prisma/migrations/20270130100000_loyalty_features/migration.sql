-- Fidelización, mejoras (2026-11-16).

-- Referidos: recompensa para el recomendado y tope anual por inquilino.
ALTER TABLE "tenants"
  ADD COLUMN "referral_friend_reward_type" TEXT,
  ADD COLUMN "referral_friend_reward_value" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "referral_max_rewards_per_year" INTEGER;

ALTER TABLE "referrals" ADD COLUMN "reward_skipped_reason" TEXT;

-- Promociones: duración (N meses y vuelve a la cuota normal) y condiciones.
ALTER TABLE "promotions"
  ADD COLUMN "duration_months" INTEGER,
  ADD COLUMN "unit_type_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "facility_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "new_customers_only" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "once_per_customer" BOOLEAN NOT NULL DEFAULT false;

-- Cupones: anunciarlos en la web y cupones de un solo uso para una persona.
-- `kind`: standard | personal | referral_friend (el del recomendado, de sistema).
ALTER TABLE "coupons"
  ADD COLUMN "announce_on_web" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "personal_for" TEXT;

-- Valoraciones: recordatorio, valoración anual y motivo de la baja.
ALTER TABLE "reviews"
  ADD COLUMN "reminded_at" TIMESTAMPTZ(6),
  ADD COLUMN "exit_reason" TEXT;

ALTER TABLE "tenants"
  ADD COLUMN "reviews_reminder_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviews_yearly_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "booking_recovery_coupon_pct" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "booking_recovery_coupon_days" INTEGER NOT NULL DEFAULT 2;
