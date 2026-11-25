'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { apiMessage } from './shared';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBillingStuck, useRetryStuck } from '@/lib/admin/billing-domains-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { formatDateTime } from '@/lib/format';

/** Emisores con registros de Veri*Factu en cola: desde cuándo, intentos y último error. */
export function StuckSection() {
  const [all, setAll] = useState(false);
  const stuck = useBillingStuck(all);
  const retry = useRetryStuck();
  const canEdit = useIsSuperadmin();

  async function run(tenantId: string, ownerId: string | null) {
    try {
      await retry.mutateAsync({ tenantId, ownerId });
      toast.success('Reintento en marcha: se enviará en cuanto salga el siguiente envío.');
    } catch (err) {
      toast.error(apiMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Envíos atascados</CardTitle>
        <CardDescription>
          Emisores con facturas en cola que no llegan a la AEAT: llevan más de 30 minutos sin
          enviarse o con envíos fallidos seguidos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Incluir también lo recién emitido
        </label>
        {stuck.isError ? (
          <AdminError onRetry={() => void stuck.refetch()} />
        ) : stuck.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (stuck.data ?? []).length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> No hay envíos atascados.
          </p>
        ) : (
          (stuck.data ?? []).map((s) => (
            <div
              key={`${s.tenantId}:${s.ownerId ?? 'self'}`}
              className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div>
                  <Link
                    href={`/admin/tenants/${s.tenantId}`}
                    className="font-medium hover:underline"
                  >
                    {s.tenantName}
                  </Link>
                  {s.emitterName && (
                    <span className="text-muted-foreground"> · propietario {s.emitterName}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {s.pendingRecords} registro(s) sin enviar desde el{' '}
                  {formatDateTime(s.oldestPendingAt)}
                  {s.consecutiveFailures > 0 &&
                    ` · ${s.consecutiveFailures} intento(s) fallido(s) seguidos`}
                  {s.retryAt && ` · próximo reintento ${formatDateTime(s.retryAt)}`}
                </p>
                {s.lastError && (
                  <p className="break-words text-xs text-red-700 dark:text-red-300">
                    Último error: {s.lastError}
                  </p>
                )}
              </div>
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 text-xs"
                  disabled={retry.isPending}
                  onClick={() => void run(s.tenantId, s.ownerId)}
                >
                  Reintentar ahora
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
