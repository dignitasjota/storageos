-- Resumen del día por correo (08:00 en la hora del tenant): último día enviado,
-- para no repetirlo aunque el cron corra cada hora o haya varias réplicas.
ALTER TABLE "tenants" ADD COLUMN "daily_summary_last_date" DATE;
