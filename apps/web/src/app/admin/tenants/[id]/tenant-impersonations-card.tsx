'use client';

import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import { useAdminImpersonationLogs, useRevokeImpersonation } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const when = (iso: string) => new Date(iso).toLocaleString('es-ES');

/**
 * Sesiones de impersonación de este tenant: quién, en qué modo, desde y hasta
 * cuándo, el motivo y si sigue abierta, con «Cortar» en las vivas (un
 * superadmin cualquiera; el resto, las suyas).
 */
export function TenantImpersonationsCard({ tenantId }: { tenantId: string }) {
  const logs = useAdminImpersonationLogs({ tenantId });
  const revoke = useRevokeImpersonation();
  const me = useAdminAuthStore((s) => s.superAdmin);
  const ask = useConfirm();
  const rows = logs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Impersonaciones</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {logs.isError ? (
          <AdminError onRetry={() => void logs.refetch()} />
        ) : logs.isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">Nadie ha entrado en su cuenta.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((s) => {
              const canCut = s.live && (me?.role === 'superadmin' || me?.id === s.superAdminId);
              return (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {s.superAdminName ?? s.superAdminEmail ?? '—'}
                      </span>
                      <Badge variant="outline">{s.readOnly ? 'Solo lectura' : 'Con cambios'}</Badge>
                      {s.live ? (
                        <Badge>Abierta</Badge>
                      ) : s.revokedAt ? (
                        <Badge variant="secondary">Cortada</Badge>
                      ) : (
                        <Badge variant="secondary">Caducada</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {when(s.createdAt)} → {when(s.revokedAt ?? s.expiresAt)} · como{' '}
                      {s.userName ?? 'el propietario'} · {s.actionsCount} acciones
                    </p>
                    <p className="text-xs">{s.reason}</p>
                  </div>
                  {canCut && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={async () => {
                        const ok = await ask({
                          title: 'Cortar la sesión',
                          description: 'Quien esté dentro sale al momento.',
                          confirmLabel: 'Cortar',
                          destructive: true,
                        });
                        if (!ok) return;
                        try {
                          await revoke.mutateAsync(s.id);
                          toast.success('Sesión cortada.');
                        } catch (err) {
                          toast.error(
                            err instanceof ApiError ? err.body.message : 'No se pudo cortar.',
                          );
                        }
                      }}
                    >
                      Cortar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {logs.hasNextPage && (
          <Button variant="ghost" size="sm" onClick={() => void logs.fetchNextPage()}>
            Ver más
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
