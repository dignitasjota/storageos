'use client';

import Link from 'next/link';
import { toast } from 'sonner';

import type { AccessCutPendingRowDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import {
  useAccessCutPending,
  useCutAccess,
  useCutAllAccess,
  useSkipAccessCut,
} from '@/lib/collections-ops/hooks';
import { formatEur } from '@/lib/format';

/**
 * Inquilinos con deuda a los que el corte de acceso no llegó a aplicarse: no se
 * cortan de golpe, se decide con cada uno. Sin nadie pendiente no se pinta.
 */
export function AccessCutsCard({ facilityId }: { facilityId?: string | undefined }) {
  const hasAccess = useHasFeature('access_control');
  const canManage = useHasPermission('access:manage');
  const enabled = hasAccess && canManage;
  const pending = useAccessCutPending(facilityId, enabled);
  const cut = useCutAccess();
  const skip = useSkipAccessCut();
  const cutAll = useCutAllAccess();
  const ask = useConfirm();
  const rows = pending.data?.rows ?? [];
  const busy = cut.isPending || skip.isPending || cutAll.isPending;
  if (!enabled || rows.length === 0) return null;
  const extrasOnly = pending.data?.mode === 'extras';

  async function run(fn: () => Promise<string>) {
    try {
      toast.success(await fn());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido hacer.');
    }
  }
  async function doCut(r: AccessCutPendingRowDto) {
    if (
      !(await ask({
        title: `¿Cortar el acceso a ${r.customerName}?`,
        description: 'Dejará de poder entrar hasta que pague. Se le devuelve solo al pagar.',
        destructive: true,
      }))
    )
      return;
    await run(async () => {
      await cut.mutateAsync(r.customerId);
      return `Acceso cortado a ${r.customerName}.`;
    });
  }
  async function doCutAll() {
    if (
      !(await ask({
        title: `¿Cortar el acceso a ${rows.length} ${rows.length === 1 ? 'inquilino' : 'inquilinos'}?`,
        description: 'Dejarán de poder entrar hasta que paguen.',
        destructive: true,
      }))
    )
      return;
    await run(async () => {
      const res = await cutAll.mutateAsync(facilityId);
      return `Acceso cortado a ${res.customers} ${res.customers === 1 ? 'inquilino' : 'inquilinos'}.${
        res.failed > 0
          ? ` A ${res.failed} no se le pudo cortar (quizá pagó entre medias): revisa la lista.`
          : ''
      }`;
    });
  }

  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Deudores con el acceso sin cortar</CardTitle>
        <CardDescription>
          Por su deuda ya les tocaba el corte, pero no llegó a aplicarse y siguen entrando. Decide
          qué hacer con cada uno.
          {extrasOnly && ' Con tu política, solo se cortan sus accesos adicionales.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.customerId} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-[180px] flex-1 text-sm">
                <Link href={`/customers/${r.customerId}`} className="font-medium hover:underline">
                  {r.customerName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {formatEur(r.amount)} · {r.days} días · {r.invoiceNumbers.join(', ')}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await skip.mutateAsync(r.customerId);
                      return `${r.customerName} sigue con su acceso.`;
                    })
                  }
                >
                  No cortar
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void doCut(r)}
                >
                  Cortar ahora
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {rows.length > 1 && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void doCutAll()}>
            Cortar a todos
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
