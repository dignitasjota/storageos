'use client';

import { DoorOpen, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PortalDoorDto, PortalOpenDoorResultDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

export function DoorOpenCard({ session }: { session: PortalSessionDto }) {
  const [doors, setDoors] = useState<PortalDoorDto[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const authHeaders = { Authorization: `Bearer ${session.accessToken}` };

  useEffect(() => {
    let cancelled = false;
    apiFetch<PortalDoorDto[]>('/portal/me/doors', { headers: authHeaders, requiresAuth: false })
      .then((list) => {
        if (!cancelled) setDoors(list);
      })
      .catch(() => {
        if (!cancelled) setDoors([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function open(door: PortalDoorDto) {
    setOpening(door.id);
    try {
      const res = await apiFetch<PortalOpenDoorResultDto>(`/portal/me/doors/${door.id}/open`, {
        method: 'POST',
        headers: authHeaders,
        requiresAuth: false,
      });
      if (res.opened) toast.success(res.message);
      else toast.error(res.message);
    } catch {
      toast.error('No se pudo abrir la puerta.');
    } finally {
      setOpening(null);
    }
  }

  // Sin puertas configuradas (o sin apertura remota) → no mostramos la card.
  if (!doors || doors.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DoorOpen className="h-5 w-5 text-primary" /> Abrir puerta
        </CardTitle>
        <CardDescription>
          Abre la puerta de tu local desde el móvil. Se aplican tu horario de acceso y el estado de
          tu cuenta.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {doors.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <p className="font-medium">{d.name}</p>
              <p className="text-xs text-muted-foreground">{d.facilityName}</p>
            </div>
            <Button onClick={() => open(d)} disabled={opening === d.id}>
              {opening === d.id ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <DoorOpen className="mr-1 h-4 w-4" />
              )}
              Abrir
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
