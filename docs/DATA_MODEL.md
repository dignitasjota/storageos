### `today_snoozes` (2026-11-05)

Avisos de «Hoy» apartados por el equipo: `kind`, `ref_id`, `label`, `until`, `created_by_user_id`; único por tenant, tipo y referencia; con RLS. `users.daily_summary_prefs` guarda hora, locales y push del resumen del día y `users.daily_summary_last_date` reserva el envío; `tenants.daily_summary_last_date` queda sin uso.
