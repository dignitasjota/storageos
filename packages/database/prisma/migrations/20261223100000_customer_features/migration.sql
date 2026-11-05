-- Revisión de Inquilinos, PR B.

ALTER TABLE customers
  ADD COLUMN merged_into_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN billing_email TEXT;

-- Personas de contacto de una empresa.
CREATE TABLE customer_contacts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  role        TEXT,
  email       TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_contacts_customer_idx ON customer_contacts (tenant_id, customer_id);

-- Documento que el equipo pide al inquilino y que este sube desde su área de clientes.
CREATE TABLE customer_document_requests (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type                 customer_document_type NOT NULL,
  note                 TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  document_id          UUID REFERENCES customer_documents(id) ON DELETE SET NULL,
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at         TIMESTAMPTZ
);
CREATE INDEX customer_document_requests_customer_idx
  ON customer_document_requests (tenant_id, customer_id, status);

-- Vistas de la lista de inquilinos, compartidas por el equipo.
CREATE TABLE customer_saved_views (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  filters            JSONB NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE customer_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_contacts FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE customer_document_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_document_requests FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE customer_saved_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_saved_views FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON customer_contacts, customer_document_requests, customer_saved_views
  TO storageos_app;
