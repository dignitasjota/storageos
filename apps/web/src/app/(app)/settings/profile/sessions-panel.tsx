'use client';

import { Laptop, Loader2, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

import type { UserSessionDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';
import { useMySessions, useRevokeMySession, useRevokeOtherSessions } from '@/lib/users/hooks';

/** «Chrome en Mac» a partir del user agent (aproximado). */
export function describeDevice(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Dispositivo desconocido', mobile: false };
  const mobile = /iPhone|iPad|Android|Mobile/i.test(ua);
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Navegador';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return { label: os ? `${browser} en ${os}` : browser, mobile };
}

/** Dispositivos con tu sesión abierta: cerrar uno o todos los demás. */
export function SessionsPanel() {
  const ask = useConfirm();
  const sessions = useMySessions();
  const revoke = useRevokeMySession();
  const revokeOthers = useRevokeOtherSessions();
  const rows = sessions.data ?? [];
  const others = rows.filter((s) => !s.current).length;

  async function onRevoke(s: UserSessionDto) {
    try {
      await revoke.mutateAsync(s.id);
      toast.success('Sesión cerrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cerrar.');
    }
  }

  async function onRevokeOthers() {
    const ok = await ask({
      title: '¿Cerrar la sesión en los demás dispositivos?',
      description: 'Tendrán que volver a entrar con tu contraseña. Este navegador sigue abierto.',
      confirmLabel: 'Cerrar las demás',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await revokeOthers.mutateAsync();
      toast.success(
        r.revoked === 1 ? 'Se ha cerrado 1 sesión.' : `Se han cerrado ${r.revoked} sesiones.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron cerrar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dónde tienes la sesión abierta</CardTitle>
        <CardDescription>
          Si ves un dispositivo que no reconoces, ciérralo y cambia tu contraseña.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessions.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((s) => {
              const d = describeDevice(s.userAgent);
              const Icon = d.mobile || s.installedApp ? Smartphone : Laptop;
              return (
                <li key={s.id} className="flex items-center gap-3 p-3 text-sm">
                  <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {d.label}
                      {s.installedApp && <Badge variant="outline">App instalada</Badge>}
                      {s.current && <Badge>Este dispositivo</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Último uso {formatDateTime(s.lastUsedAt)}
                      {s.ipAddress ? ` · IP ${s.ipAddress}` : ''}
                    </p>
                  </div>
                  {!s.current && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={() => void onRevoke(s)}
                    >
                      Cerrar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {others > 0 && (
          <Button
            variant="destructive"
            onClick={() => void onRevokeOthers()}
            disabled={revokeOthers.isPending}
          >
            Cerrar la sesión en los demás dispositivos
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
