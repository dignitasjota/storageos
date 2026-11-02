'use client';

import { useEffect, useState } from 'react';

import { EmailProblemsPanel, EmailStatsPanel } from '@/components/admin/comms/email-insights';
import { PlatformEmailLog } from '@/components/admin/platform-email-log';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function AdminEmailLogPage() {
  const [tab, setTab] = useState('log');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'stats' || t === 'problems') setTab(t);
  }, []);
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
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="log">Correos</TabsTrigger>
          <TabsTrigger value="stats">Resumen</TabsTrigger>
          <TabsTrigger value="problems">Direcciones con problemas</TabsTrigger>
        </TabsList>
        <TabsContent value="log" className="mt-4">
          <PlatformEmailLog />
        </TabsContent>
        <TabsContent value="stats" className="mt-4">
          <EmailStatsPanel />
        </TabsContent>
        <TabsContent value="problems" className="mt-4">
          <EmailProblemsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
