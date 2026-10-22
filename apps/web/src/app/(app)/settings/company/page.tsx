'use client';

import { BillingDetailsSection } from '../saas-billing/billing-details-section';

/** Datos fiscales de la empresa: emisor de sus facturas y titular de su web. */
export default function CompanySettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Datos de tu empresa</h1>
        <p className="text-sm text-muted-foreground">
          Razón social, NIF y domicilio fiscal con los que facturas.
        </p>
      </div>
      <BillingDetailsSection variant="company" />
    </div>
  );
}
