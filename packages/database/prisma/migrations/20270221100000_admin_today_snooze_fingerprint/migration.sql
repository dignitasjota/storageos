-- «Hoy» del super admin: al apartar un aviso se guarda cómo estaba (último
-- mensaje del cliente, deuda, dispositivos sin conexión…). Si empeora, el aviso
-- vuelve a salir aunque siga apartado.
ALTER TABLE "admin_today_snoozes" ADD COLUMN "fingerprint" JSONB;
