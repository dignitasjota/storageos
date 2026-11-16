-- Fidelización, revisión (2026-11-16): promociones, referidos y valoraciones.

-- 1. El negocio elige qué promoción se anuncia en su web (y vale en la reserva
--    online). La que la web anunciaba hasta hoy —la más reciente usable— se
--    sigue anunciando.
ALTER TABLE "promotions" ADD COLUMN "announce_on_web" BOOLEAN NOT NULL DEFAULT false;

UPDATE "promotions" SET "announce_on_web" = true
WHERE "id" IN (
  SELECT DISTINCT ON (p."tenant_id") p."id"
  FROM "promotions" p
  WHERE p."is_active"
    AND (p."valid_from" IS NULL OR p."valid_from" <= now())
    AND (p."valid_until" IS NULL OR p."valid_until" >= now())
    AND (p."max_uses" IS NULL OR p."used_count" < p."max_uses")
    AND (p."applies_to"->>'unitId') IS NULL
    AND NOT EXISTS (SELECT 1 FROM "referrals" r WHERE r."reward_promotion_id" = p."id")
  ORDER BY p."tenant_id", p."created_at" DESC
);

-- 2. La recompensa fija de un referido se reparte entre las facturas que haga
--    falta: cuánto se ha descontado ya.
ALTER TABLE "referrals" ADD COLUMN "reward_applied_amount" DECIMAL(10, 2) NOT NULL DEFAULT 0;

UPDATE "referrals" SET "reward_applied_amount" = "reward_value"
WHERE "reward_applied_at" IS NOT NULL AND "reward_type" = 'fixed' AND "reward_value" IS NOT NULL;

-- 3. La recompensa se gana cuando el recomendado paga, no al firmar: las
--    concedidas y aún sin descontar cuyo recomendado no ha pagado nada vuelven
--    a quedar pendientes (se concederán con su primer pago).
UPDATE "referrals" r
SET "status" = 'pending', "converted_at" = NULL, "reward_type" = NULL, "reward_value" = NULL
WHERE r."status" = 'converted'
  AND r."reward_applied_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "payments" p
    WHERE p."customer_id" = r."referred_customer_id"
      AND p."status" IN ('succeeded', 'partially_refunded')
      AND p."amount" > 0
      AND p."method_type" NOT IN ('credit_note', 'withholding', 'deposit')
  );

-- 4. Permiso del autor para publicar su valoración en la web.
ALTER TABLE "reviews" ADD COLUMN "publish_consent" BOOLEAN NOT NULL DEFAULT false;
