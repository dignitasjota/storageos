-- Web «Premium»: el operador personaliza su web pública (`/s/<slug>`) —
-- plantilla de diseño + claim del hero + sección «quiénes somos». Gateado por la
-- feature `web_premium` (add-on). Sin la feature, la web usa la plantilla por
-- defecto y estos campos se ignoran.
ALTER TABLE "tenants"
  ADD COLUMN "web_template" TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN "web_headline" TEXT,
  ADD COLUMN "web_about"    TEXT;
