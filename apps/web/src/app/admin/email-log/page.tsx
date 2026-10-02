'use client';

import { PlatformEmailLog } from '@/components/admin/platform-email-log';

export default function AdminEmailLogPage() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Correos enviados</h1>
        <p className="text-sm text-muted-foreground">
          Lo que manda la plataforma a los tenants: verificación, contraseña, invitaciones,
          suscripción y facturas, tus emails y anuncios, avisos al equipo e informe mensual. Los
          correos de cada tenant a sus inquilinos están en su panel (Comunicaciones). Se guardan 180
          días.
        </p>
      </div>
      <PlatformEmailLog />
    </div>
  );
}
