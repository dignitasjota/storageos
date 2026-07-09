-- Cuenta EXENTA de facturación SaaS: el propietario del SaaS operando como
-- tenant, demos, partners o cortesías. Opera con su plan sin pagar y NO cuenta
-- en ninguna estadística de negocio (MRR, ARPU, ingresos, churn, trials, dunning).
ALTER TABLE "tenants" ADD COLUMN "billing_exempt" BOOLEAN NOT NULL DEFAULT false;
