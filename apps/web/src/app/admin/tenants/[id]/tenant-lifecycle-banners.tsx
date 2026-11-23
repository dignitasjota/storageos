'use client';

import { toast } from 'sonner';

import type { AdminTenantDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { churnReasonLabel } from '@/lib/admin/churn';
import {
  useCancelAnonymize,
  useFixConsistency,
  useTenantConsistency,
  useUndoCancelTenant,
} from '@/lib/admin/tenant-lifecycle-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');
const AMBER =
  'flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200';

/** Baja o anonimización programadas, con deshacer mientras no se apliquen. */
export function ScheduledBanners({ tenant }: { tenant: AdminTenantDto }) {
  const canEdit = useIsSuperadmin();
  const ask = useConfirm();
  const undo = useUndoCancelTenant(tenant.id);
  const cancelAnon = useCancelAnonymize(tenant.id);

  async function undoCancel() {
    const res = await ask({
      title: 'Deshacer la baja',
      description:
        'Sigue como cliente. Si pagaba por SEPA o con tarjeta guardada, vuelve a cobrarse igual; si pagaba por Stripe, queda en pago manual (su suscripción de Stripe ya se canceló).',
      confirmLabel: 'Deshacer la baja',
      input: { label: 'Motivo', required: true },
    });
    if (!res) return;
    try {
      await undo.mutateAsync(res.value);
      toast.success('Baja deshecha.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo deshacer.');
    }
  }

  async function stopAnonymize() {
    const res = await ask({
      title: 'Cancelar la anonimización',
      description: 'Sus datos no se borrarán. Sigue dado de baja.',
      confirmLabel: 'No anonimizar',
      input: { label: 'Motivo', required: true },
    });
    if (!res) return;
    try {
      await cancelAnon.mutateAsync(res.value);
      toast.success('Anonimización cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  return (
    <>
      {tenant.cancelScheduledAt && (
        <div className={AMBER}>
          <span>
            Se da de baja el <strong>{day(tenant.cancelScheduledAt)}</strong>
            {tenant.cancelScheduledReason
              ? ` (${churnReasonLabel(tenant.cancelScheduledReason)})`
              : ''}
            . Ya no se le cobra; hasta ese día sigue operando.
            {tenant.cancelScheduledNote ? ` Nota: ${tenant.cancelScheduledNote}` : ''}
          </span>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => void undoCancel()}>
              Deshacer la baja
            </Button>
          )}
        </div>
      )}
      {tenant.anonymizeScheduledAt && (
        <div className={AMBER.replace(/amber/g, 'red')}>
          <span>
            Sus datos se anonimizarán el <strong>{day(tenant.anonymizeScheduledAt)}</strong>. Se
            avisó al propietario por correo.
          </span>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => void stopAnonymize()}>
              Cancelar la anonimización
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/** Avisos de incoherencias en la suscripción, con su arreglo. */
export function ConsistencyIssues({ tenantId }: { tenantId: string }) {
  const q = useTenantConsistency(tenantId);
  const fix = useFixConsistency(tenantId);
  const canEdit = useIsSuperadmin();
  const ask = useConfirm();
  const issues = q.data?.issues ?? [];
  if (issues.length === 0) return null;
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
        Hay {issues.length === 1 ? 'algo que no cuadra' : `${issues.length} cosas que no cuadran`}
      </p>
      {issues.map((i) => (
        <div
          key={i.code}
          className="rounded-md border border-amber-300 p-2 text-xs dark:border-amber-800"
        >
          <p className="font-medium">{i.title}</p>
          <p className="text-muted-foreground">{i.detail}</p>
          {i.fixLabel && canEdit && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1.5"
              disabled={fix.isPending}
              onClick={async () => {
                const ok = await ask({
                  title: i.fixLabel ?? 'Corregir',
                  description: i.detail,
                  confirmLabel: i.fixLabel ?? 'Corregir',
                });
                if (!ok) return;
                try {
                  await fix.mutateAsync(i.code);
                  toast.success('Corregido.');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo corregir.');
                }
              }}
            >
              {i.fixLabel}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
