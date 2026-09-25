-- Anti-replay de TOTP: último paso de 30 s aceptado en un login con 2FA. Un
-- código ya usado (o de un paso anterior) no vuelve a valer, aunque siga
-- dentro de la ventana de tolerancia (±1 paso).
ALTER TABLE "users" ADD COLUMN "two_factor_last_step" BIGINT;
ALTER TABLE "super_admins" ADD COLUMN "two_factor_last_step" BIGINT;
