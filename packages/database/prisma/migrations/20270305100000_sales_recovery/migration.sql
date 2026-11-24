-- Comerciales: no interesados y recuperación.

-- Un prospecto «no interesado» (o un cliente que se da de baja) queda
-- archivado en la cartera de su comercial con la fecha de volver a intentarlo.
-- «No volver a contactar» es un archivado sin fecha y sin correos ni
-- recordatorios (también para las secuencias y las cadencias).
ALTER TABLE platform_leads
  ADD COLUMN sales_archived_at TIMESTAMPTZ,
  ADD COLUMN sales_recover_on DATE,
  ADD COLUMN sales_recover_notified_at TIMESTAMPTZ,
  ADD COLUMN do_not_contact BOOLEAN NOT NULL DEFAULT false;

-- Los perdidos que ya llevaban los comerciales pasan a archivados (sin fecha).
UPDATE platform_leads
SET sales_archived_at = COALESCE(lost_at, updated_at)
WHERE sales_rep_id IS NOT NULL AND status = 'lost' AND discarded_at IS NULL;

CREATE INDEX platform_leads_sales_recover_idx ON platform_leads (sales_recover_on)
  WHERE sales_archived_at IS NOT NULL AND sales_recover_on IS NOT NULL;

-- Meses hasta volver a intentarlo, por motivo (Reglas del equipo).
ALTER TABLE platform_sales_settings
  ADD COLUMN recover_months JSONB NOT NULL DEFAULT
    '{"not_now":6,"price":12,"competitor":12,"no_response":3,"own_software":12,"missing_feature":12,"no_conversion":12,"churned":12,"other":12}';

-- Cada archivado y su recuperación: quién lo intenta, cuándo vuelve y si
-- acaba pagando. Un cliente dado de baja que vuelve a contratar comisiona a
-- la mitad (venta y cuota, según el plan de su comercial).
CREATE TABLE sales_recoveries (
  id UUID NOT NULL DEFAULT uuid_generate_v7(),
  lead_id UUID NOT NULL,
  rep_id UUID NOT NULL,
  tenant_id UUID,
  -- prospect · client
  kind TEXT NOT NULL,
  reason_code TEXT,
  archived_at TIMESTAMPTZ NOT NULL,
  recover_on DATE,
  recovered_at TIMESTAMPTZ,
  won_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_recoveries_pkey PRIMARY KEY (id)
);
ALTER TABLE sales_recoveries ADD CONSTRAINT sales_recoveries_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES platform_leads(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE sales_recoveries ADD CONSTRAINT sales_recoveries_rep_id_fkey
  FOREIGN KEY (rep_id) REFERENCES super_admins(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE sales_recoveries ADD CONSTRAINT sales_recoveries_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX sales_recoveries_lead_idx ON sales_recoveries (lead_id, archived_at DESC);
CREATE INDEX sales_recoveries_rep_idx ON sales_recoveries (rep_id, recovered_at);
CREATE INDEX sales_recoveries_tenant_idx ON sales_recoveries (tenant_id) WHERE tenant_id IS NOT NULL;

-- Tabla global (como el resto de las del equipo comercial): fuera del rol de la app.
REVOKE ALL ON sales_recoveries FROM storageos_app;

-- La comisión de una recuperación apunta a ella (una venta por recuperación).
ALTER TABLE sales_commission_items ADD COLUMN recovery_id UUID;
ALTER TABLE sales_commission_items ADD CONSTRAINT sales_commission_items_recovery_id_fkey
  FOREIGN KEY (recovery_id) REFERENCES sales_recoveries(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX sales_commission_items_recovery_key ON sales_commission_items (recovery_id)
  WHERE kind = 'recovery';
