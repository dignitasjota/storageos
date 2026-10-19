'use client';

import { AlertTriangle, CheckCircle2, Circle, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useBulkRemindInvoices } from '@/lib/billing/hooks';
import { useCustomerAccount } from '@/lib/customers/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

const DEPOSIT: Record<string, string> = {
  none: 'sin fianza',
  held: 'retenida',
  returned: 'devuelta',
  partially_returned: 'devuelta en parte',
};

/**
 * Estado de cuenta del inquilino, arriba de su ficha: lo que paga al mes y por
 * qué contrato, cómo se le cobra, el próximo cargo, la deuda con el paso del
 * escalado en que va, y accesos rápidos para recordarle el pago o ir a sus
 * facturas y métodos de pago.
 */
export function CustomerAccountCard({
  customerId,
  onGoTo,
}: {
  customerId: string;
  onGoTo: (tab: string) => void;
}) {
  const account = useCustomerAccount(customerId);
  const remind = useBulkRemindInvoices();
  const canRemind = useHasPermission('communications:send');
  const a = account.data;
  if (!a) return null;
  if (a.lines.length === 0 && !a.overdue && a.pendingNotDue === 0) return null;

  async function doRemind() {
    if (!a?.overdue) return;
    try {
      const res = await remind.mutateAsync(a.overdue.invoices.map((i) => i.id));
      toast.success(
        res.succeeded.length > 0
          ? `Recordatorio enviado (${res.succeeded.length} ${res.succeeded.length === 1 ? 'factura' : 'facturas'}).`
          : 'No se pudo enviar el recordatorio.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Card>
      <CardContent className="grid gap-4 p-4 sm:p-5 lg:grid-cols-3">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Paga al mes</p>
          <p className="text-2xl font-semibold tabular-nums">
            {eur(a.monthly)}{' '}
            <span className="text-xs font-normal text-muted-foreground">sin IVA</span>
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {a.lines.map((l) => (
              <li key={l.contractId}>
                <Link
                  href={`/contracts/${l.contractId}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {l.unitCode}
                </Link>{' '}
                · {l.facilityName} · {eur(l.rent)}
                {l.discount > 0 && ` − ${eur(l.discount)}`}
                {l.insurance > 0 && ` + seguro ${eur(l.insurance)}`}
                {l.billingIntervalMonths > 1 &&
                  ` · prepago ${l.billingIntervalMonths === 12 ? 'anual' : `${l.billingIntervalMonths} meses`}`}
                {l.status === 'ending' && l.endDate && ` · en baja hasta ${day(l.endDate)}`}
                {l.depositAmount > 0 &&
                  ` · fianza ${eur(l.depositAmount)} ${DEPOSIT[l.depositStatus] ?? ''}`}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Cobro</p>
          {a.payViaLabel ? (
            <p className="flex items-center gap-2 text-sm">
              <CreditCard className="size-4 text-muted-foreground" />
              {a.payViaLabel}
            </p>
          ) : (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Sin método de pago guardado: paga a mano.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {a.payVia === 'sepa_mandate'
              ? 'Va en la remesa SEPA del mes.'
              : a.autoCharge
                ? 'Se le cobra solo al emitir la factura.'
                : a.payVia
                  ? 'El cobro automático está apagado: hay que cobrarle a mano.'
                  : 'Pídele que guarde tarjeta o IBAN en su área de clientes.'}
          </p>
          {a.nextCharge && (
            <p className="text-sm">
              Próxima factura: <span className="font-medium">{eur(a.nextCharge.amount)}</span>{' '}
              <span className="text-muted-foreground">el {day(a.nextCharge.date)} (sin IVA)</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Pagado en 12 meses: {eur(a.paid12m)}
            {a.nightPasses30d > 0 && ` · ${a.nightPasses30d} pase(s) nocturno(s) este mes`}
          </p>
          {!a.payVia && (
            <Button variant="outline" size="sm" onClick={() => onGoTo('payments')}>
              Añadir método de pago
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Deuda</p>
          {a.overdue ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="size-4" />
                Debe {eur(a.overdue.amount)} desde el {day(a.overdue.since)} ({a.overdue.days}{' '}
                {a.overdue.days === 1 ? 'día' : 'días'})
              </p>
              {a.overdue.steps.length > 0 && (
                <ol className="space-y-0.5 text-xs">
                  {a.overdue.steps.map((s) => (
                    <li key={s.type} className="flex items-center gap-1.5">
                      {s.executedAt ? (
                        <CheckCircle2 className="size-3.5 text-destructive" />
                      ) : (
                        <Circle className="size-3.5 text-muted-foreground" />
                      )}
                      {s.label}{' '}
                      <span className="text-muted-foreground">
                        {s.executedAt
                          ? day(s.executedAt)
                          : s.status === 'cancelled'
                            ? 'cancelado'
                            : `el ${day(s.scheduledFor)}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="flex flex-wrap gap-2">
                {canRemind && (
                  <Button size="sm" onClick={() => void doRemind()} disabled={remind.isPending}>
                    Recordar el pago
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onGoTo('history')}>
                  Ver facturas
                </Button>
              </div>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" /> Al día
            </p>
          )}
          {a.pendingNotDue > 0 && (
            <p className="text-xs text-muted-foreground">
              {eur(a.pendingNotDue)} emitido y aún sin vencer.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
