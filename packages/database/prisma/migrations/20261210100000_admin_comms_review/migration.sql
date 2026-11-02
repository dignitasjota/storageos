-- Revisión de «Comunicación» del panel admin (PR A).

-- Tickets que abre el super admin al escribir a un tenant: no cuentan en los
-- tiempos de respuesta ni en «esperando tu respuesta» hasta que el tenant contesta.
ALTER TABLE support_tickets ADD COLUMN opened_by_admin BOOLEAN NOT NULL DEFAULT false;
UPDATE support_tickets t SET opened_by_admin = true
WHERE t.created_by_user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM support_ticket_messages m
    WHERE m.ticket_id = t.id AND m.author_admin_id IS NOT NULL
      AND m.created_at = (SELECT min(created_at) FROM support_ticket_messages WHERE ticket_id = t.id)
  );

-- Banner global: fecha de fin y si el usuario puede cerrarlo.
ALTER TABLE platform_banner ADD COLUMN ends_at TIMESTAMPTZ(6);
ALTER TABLE platform_banner ADD COLUMN dismissible BOOLEAN NOT NULL DEFAULT true;

-- Novedades: fecha de la primera publicación (despublicar y volver a publicar la conserva).
ALTER TABLE product_updates ADD COLUMN first_published_at TIMESTAMPTZ(6);
UPDATE product_updates SET first_published_at = published_at WHERE published_at IS NOT NULL;

-- «Mensajes de TrasterOS»: leído por el tenant.
ALTER TABLE tenant_platform_messages ADD COLUMN read_at TIMESTAMPTZ(6);
UPDATE tenant_platform_messages SET read_at = created_at;

-- Baja de los anuncios comerciales de TrasterOS (por usuario del equipo).
ALTER TABLE users ADD COLUMN platform_news_opt_out_at TIMESTAMPTZ(6);
