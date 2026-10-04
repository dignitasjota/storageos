'use client';

import { HoldedCard } from '../billing/holded-card';

/** Copia contable en Holded (o emisión en Holded, según «Dónde se emiten tus facturas»). */
export default function AccountingSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contabilidad</h1>
        <p className="text-sm text-muted-foreground">
          Conexión con Holded. La exportación para tu asesoría (Excel con facturas, cobros y
          fianzas) está en Fiscalidad → «Exportación para la asesoría».
        </p>
      </div>
      <HoldedCard />
    </div>
  );
}
