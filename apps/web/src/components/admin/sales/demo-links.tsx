'use client';

import { ExternalLink, Globe, Loader2, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { errorText } from './common';

import type { SalesDemoPortalLinkDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';

/**
 * Las otras dos caras de la demo: el área de clientes de una inquilina y la web
 * pública del negocio. Lo que se haga ahí (un mensaje, pedir un trastero,
 * reservar desde la web) le llega a la cuenta de demostración.
 */
export function DemoExtraLinks({
  tenantSlug,
  openPortal,
  portalPending,
  size = 'default',
}: {
  tenantSlug: string | null;
  openPortal: () => Promise<SalesDemoPortalLinkDto>;
  portalPending: boolean;
  size?: 'default' | 'sm';
}) {
  async function goPortal() {
    // La pestaña se abre ya: si se abre tras la espera, el navegador la bloquea.
    const tab = window.open('', '_blank');
    try {
      const { url } = await openPortal();
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err) {
      tab?.close();
      toast.error(errorText(err, 'No se ha podido abrir el área de clientes.'));
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size={size}
          variant="outline"
          disabled={portalPending}
          onClick={() => void goPortal()}
        >
          {portalPending ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : (
            <UserRound className="mr-1.5 size-4" />
          )}
          Área de clientes
          <ExternalLink className="ml-1.5 size-3.5" />
        </Button>
        {tenantSlug && (
          <Button size={size} variant="outline" asChild>
            <a href={`/s/${tenantSlug}`} target="_blank" rel="noopener noreferrer">
              <Globe className="mr-1.5 size-4" />
              Web pública
              <ExternalLink className="ml-1.5 size-3.5" />
            </a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        En el área de clientes entras como Laura, una inquilina: lo que haga (escribir un mensaje,
        pedir otro trastero, reportar una incidencia) le llega al negocio de la demo. Desde la web
        puedes reservar un trastero como un cliente nuevo y ver la reserva en el panel.
      </p>
    </div>
  );
}
