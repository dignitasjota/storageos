'use client';

import { BillingDetailsSection } from '../saas-billing/billing-details-section';

import { BusinessProfileCard } from './business-profile-card';

/** Datos de la empresa: nombre y zona horaria, y los datos fiscales con los que factura. */
export default function CompanySettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Datos de tu empresa</h1>
        <p className="text-sm text-muted-foreground">
          Nombre comercial, zona horaria y los datos fiscales (razón social, NIF y domicilio) con
          los que facturas.
        </p>
      </div>
      <BusinessProfileCard />
      <BillingDetailsSection variant="company" />
    </div>
  );
}
