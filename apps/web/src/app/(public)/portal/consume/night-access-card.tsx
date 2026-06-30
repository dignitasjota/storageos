'use client';

import { Clock, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PortalFacilityDto, PortalNightPassDto, PortalSessionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/auth/api';

const PASS_STATUS: Record<
  PortalNightPassDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  active: { label: 'Sin usar', variant: 'default' },
  used: { label: 'Utilizado', variant: 'secondary' },
  expired: { label: 'Caducado', variant: 'outline' },
};

function scheduleText(f: PortalFacilityDto): string {
  if (!f.accessCurfewEnabled || !f.accessCurfewStart || !f.accessCurfewEnd) {
    return 'Acceso libre las 24 horas.';
  }
  return `Puedes entrar de ${f.accessCurfewEnd} a ${f.accessCurfewStart}. De ${f.accessCurfewStart} a ${f.accessCurfewEnd} el local está cerrado: necesitas un pase nocturno.`;
}

/**
 * Informa al inquilino del horario de acceso de su local (toque de queda) para
 * que sepa cuándo necesita un pase nocturno, y muestra el historial de pases
 * comprados.
 */
export function NightAccessCard({
  session,
  facilities,
  refreshKey,
}: {
  session: PortalSessionDto;
  facilities: PortalFacilityDto[];
  /** Cambia para forzar recarga del historial tras comprar un pase. */
  refreshKey?: number;
}) {
  const [passes, setPasses] = useState<PortalNightPassDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PortalNightPassDto[]>('/portal/me/access/night-passes', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setPasses(p);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken, refreshKey]);

  const curfewFacilities = facilities.filter((f) => f.accessCurfewEnabled);

  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Clock className="size-4" /> Horario de acceso
        </p>
        {facilities.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Consulta el horario con tu gestor.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {facilities.map((f) => (
              <li key={f.id}>
                <span className="font-medium text-foreground">{f.name}:</span> {scheduleText(f)}
              </li>
            ))}
          </ul>
        )}
        {curfewFacilities.length > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600">
            <Moon className="size-3.5" /> ¿Necesitas entrar fuera de ese horario? Compra un pase
            nocturno aquí abajo.
          </p>
        )}
      </div>

      {passes.length > 0 && (
        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">Tus pases nocturnos</p>
          <ul className="mt-1 space-y-1">
            {passes.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {new Date(p.createdAt).toLocaleDateString('es-ES', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
                <Badge variant={PASS_STATUS[p.status].variant}>{PASS_STATUS[p.status].label}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
