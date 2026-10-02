-- Preferencias de cada usuario sobre los avisos por correo al equipo.
-- Guarda solo lo que el usuario cambió ({tipo: true|false}); lo que falta toma
-- el valor por defecto de su rol (propietarios y gestores: sí; resto: no).
ALTER TABLE "users" ADD COLUMN "email_notice_prefs" JSONB NOT NULL DEFAULT '{}';
