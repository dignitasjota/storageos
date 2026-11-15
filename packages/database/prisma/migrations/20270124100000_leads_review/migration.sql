-- Revisión de Leads, Seguimientos y Oportunidades (2026-11-15).

-- Reserva online hecha desde el contacto: el contacto se da por ganado al
-- firmar, no al reservar. `booked_at` guarda cuándo reservó (para los informes
-- de marketing, que contaban la reserva por `won_at`).
ALTER TABLE leads ADD COLUMN booked_at TIMESTAMPTZ;
-- El contacto volvió a escribir (mismo email o teléfono) y nadie le ha atendido aún.
ALTER TABLE leads ADD COLUMN returned_at TIMESTAMPTZ;

UPDATE leads SET booked_at = won_at
WHERE converted_contract_id IS NOT NULL AND won_at IS NOT NULL;

-- Los «ganados» por una reserva online que nunca se firmó vuelven a abiertos.
UPDATE leads l SET status = 'qualified', won_at = NULL,
  qualified_at = COALESCE(l.qualified_at, l.won_at)
FROM contracts c
WHERE c.id = l.converted_contract_id AND l.status = 'won' AND c.signed_at IS NULL;

-- Meses que se guardan los contactos perdidos sin actividad (después se anonimizan).
ALTER TABLE tenants ADD COLUMN lead_retention_months INTEGER NOT NULL DEFAULT 12;

-- Lo que se propuso en cada oferta (contratos sin seguro, contrato a ampliar…).
ALTER TABLE customer_offers ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}';

-- Seguimientos huérfanos: los de contactos perdidos o borrados y los de
-- inquilinos borrados se cancelan.
UPDATE lead_followups f SET status = 'cancelled', completed_at = now()
FROM leads l
WHERE l.id = f.lead_id AND f.status = 'pending' AND (l.status = 'lost' OR l.deleted_at IS NOT NULL);

UPDATE customer_followups f SET status = 'cancelled', completed_at = now()
FROM customers c
WHERE c.id = f.customer_id AND f.status = 'pending' AND c.deleted_at IS NOT NULL;
