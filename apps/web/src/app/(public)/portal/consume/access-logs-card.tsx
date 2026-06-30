'use client';

import { History } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PortalAccessLogDto, PortalSessionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function methodLabel(m: string): string {
  if (m === 'pin') return 'PIN';
  if (m === 'qr') return 'QR';
  if (m === 'rfid') return 'Tarjeta';
  return m;
}

/** Historial de accesos del inquilino: sus entradas, por transparencia y seguridad. */
export function AccessLogsCard({ session }: { session: PortalSessionDto }) {
  const [logs, setLogs] = useState<PortalAccessLogDto[]>([]);

  useEffect(() => {
    apiFetch<PortalAccessLogDto[]>('/portal/me/access-logs', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
      .then(setLogs)
      .catch(() => {
        /* opcional */
      });
  }, [session.accessToken]);

  if (logs.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4" /> Historial de accesos
        </CardTitle>
        <CardDescription>
          Tus últimas entradas. Si ves algo que no reconoces, avísanos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {logs.map((l) => {
            const allowed = l.result === 'allowed';
            return (
              <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{l.deviceName ?? 'Acceso'}</span>
                  <span className="text-xs text-muted-foreground">
                    {fmtDateTime(l.occurredAt)} · {methodLabel(l.method)}
                  </span>
                </span>
                <Badge variant={allowed ? 'default' : 'destructive'} className="shrink-0">
                  {allowed ? 'Entrada' : 'Denegado'}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
