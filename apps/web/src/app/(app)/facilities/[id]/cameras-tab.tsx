'use client';

import { Loader2, Video } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCameraEvents } from '@/lib/cameras/hooks';

/**
 * Eventos recientes de cámara/alarma de este local (con miniatura del snapshot).
 * El vídeo en vivo se ve en la app del fabricante (DMSS). La gestión de los
 * dispositivos está en /cameras.
 */
export function FacilityCamerasTab({ facilityId }: { facilityId: string }) {
  const events = useCameraEvents(facilityId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Eventos e imágenes de las cámaras/alarma de este local.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/cameras">Gestionar cámaras</Link>
        </Button>
      </div>

      {events.isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (events.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin eventos de cámara en este local todavía.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(events.data ?? []).map((e) => (
            <div key={e.id} className="overflow-hidden rounded-lg border">
              {e.snapshotUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={e.snapshotUrl}
                  alt={e.eventType}
                  className="h-32 w-full bg-muted object-cover"
                />
              ) : (
                <div className="flex h-32 w-full items-center justify-center bg-muted text-muted-foreground">
                  <Video className="h-6 w-6" />
                </div>
              )}
              <div className="space-y-0.5 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{e.eventType}</span>
                  <Badge variant={e.kind === 'alarm' ? 'destructive' : 'outline'}>
                    {e.kind === 'alarm' ? 'Alarma' : 'Cámara'}
                  </Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {e.cameraName} · {new Date(e.occurredAt).toLocaleString('es-ES')}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
