'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ArrearsRowDto, PaymentPlanDto } from '@storageos/shared';

import { PaymentPlanDialog } from '@/components/billing/payment-plan-dialog';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useBulkChargeInvoices, useBulkRemindInvoices } from '@/lib/billing/hooks';
import { useOpenCase } from '@/lib/collections/hooks';
import { useArrears, useCancelPaymentPlan, usePaymentPlans } from '@/lib/collections-ops/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('es-ES');

const PLAN_STATUS: Record<string, string> = {
  active: 'Al día',
  broken: 'Incumplido',
  completed: 'Pagado',
  cancelled: 'Cancelado',
};

/**
 * Deudores: un inquilino por fila con lo que debe, desde cuándo, en qué paso
 * del escalado va y si tiene plan de pago o expediente; con las acciones para
 * reclamarlo (recordar, cobrar, plan de pago, expediente).
 */
export default function ArrearsPage() {
  const facilityId = useHeaderFacilityId();
  const arrears = useArrears(facilityId);
  const plans = usePaymentPlans();
  const remind = useBulkRemindInvoices();
  const charge = useBulkChargeInvoices();
  const openCase = useOpenCase();
  const cancelPlan = useCancelPaymentPlan();
  const ask = useConfirm();
  const canCharge = useHasPermission('payments:charge');
  const canRemind = useHasPermission('communications:send');
  const canCase = useHasPermission('collections:manage');
  const hasCollections = useHasFeature('collections');
  const [planFor, setPlanFor] = useState<ArrearsRowDto | null>(null);
  const d = arrears.data;
  const livePlans = (plans.data ?? []).filter(
    (p) => p.status === 'active' || p.status === 'broken',
  );

  async function doRemind(r: ArrearsRowDto) {
    try {
      const res = await remind.mutateAsync(r.invoiceIds);
      toast.success(
        `Recordatorio enviado a ${r.customerName} (${res.succeeded.length} factura(s)).`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }
  async function doCharge(r: ArrearsRowDto) {
    if (
      !(await ask({
        title: `¿Cobrar ${eur(r.amount)} a ${r.customerName} con su método guardado?`,
      }))
    )
      return;
    try {
      const res = await charge.mutateAsync(r.invoiceIds);
      if (res.failed.length)
        toast.error(`${res.failed.length} cobro(s) no se pudieron hacer: ${res.failed[0]!.error}`);
      else toast.success('Cobro lanzado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cobrar.');
    }
  }
  async function doCase(r: ArrearsRowDto) {
    if (!r.contractId) return;
    if (!(await ask({ title: `¿Abrir expediente de impago a ${r.customerName}?` }))) return;
    try {
      await openCase.mutateAsync({ contractId: r.contractId });
      toast.success('Expediente abierto.');
      void arrears.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir.');
    }
  }
  async function doCancelPlan(p: PaymentPlanDto) {
    if (
      !(await ask({
        title: `¿Cancelar el plan de pago de ${p.customerName}?`,
        description: 'El escalado de impagos de esas facturas vuelve a seguir su curso.',
        destructive: true,
      }))
    )
      return;
    try {
      await cancelPlan.mutateAsync(p.id);
      toast.success('Plan cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deudores</h1>
        <p className="text-sm text-muted-foreground">
          Inquilinos con facturas vencidas, en qué punto está cada uno y qué hacer.
        </p>
      </div>

      {arrears.isLoading || !d ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Card className="col-span-2">
              <CardContent className="space-y-1 p-4">
                <p className="text-xs text-muted-foreground">Deuda vencida</p>
                <p className="text-2xl font-semibold tabular-nums text-destructive">
                  {eur(d.totalAmount)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.customers} {d.customers === 1 ? 'inquilino' : 'inquilinos'}
                </p>
              </CardContent>
            </Card>
            {d.aging.map((a) => (
              <Card key={a.label}>
                <CardContent className="space-y-1 p-4">
                  <p className="text-xs text-muted-foreground">{a.label}</p>
                  <p className="text-lg font-semibold tabular-nums">{eur(a.amount)}</p>
                  <p className="text-xs text-muted-foreground">{a.count}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              {d.rows.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Nadie debe nada. 🎉</p>
              ) : (
                <ul className="divide-y">
                  {d.rows.map((r) => (
                    <li key={r.customerId} className="flex flex-wrap items-start gap-3 p-4">
                      <div className="min-w-[180px] flex-1">
                        <Link
                          href={`/customers/${r.customerId}`}
                          className="font-medium hover:underline"
                        >
                          {r.customerName}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {[r.units.join(', '), r.phone, r.email].filter(Boolean).join(' · ') ||
                            '—'}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.chargeable && <Badge variant="outline">Tiene tarjeta/adeudo</Badge>}
                          {r.sepaMandate && <Badge variant="outline">Remesa SEPA</Badge>}
                          {r.lateFeeApplied && <Badge variant="outline">Con recargo</Badge>}
                          {r.accessBlocked && <Badge variant="destructive">Acceso cortado</Badge>}
                          {r.plan && (
                            <Badge
                              variant={r.plan.status === 'broken' ? 'destructive' : 'secondary'}
                            >
                              Plan {PLAN_STATUS[r.plan.status]?.toLowerCase()}
                              {r.plan.nextDue &&
                                r.plan.status === 'active' &&
                                ` · próxima ${day(r.plan.nextDue)}`}
                            </Badge>
                          )}
                          {r.collectionsCase && (
                            <Link href={`/collections/${r.collectionsCase.id}`}>
                              <Badge variant="secondary">Expediente abierto</Badge>
                            </Link>
                          )}
                        </div>
                      </div>
                      <div className="w-36 text-sm">
                        <p className="font-semibold tabular-nums text-destructive">
                          {eur(r.amount)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {r.invoiceCount} {r.invoiceCount === 1 ? 'factura' : 'facturas'} ·{' '}
                          {r.days} días
                        </p>
                      </div>
                      <div className="w-48 text-xs text-muted-foreground">
                        <p>Último aviso: {r.lastReminderAt ? day(r.lastReminderAt) : 'ninguno'}</p>
                        <p>
                          Siguiente:{' '}
                          {r.plan?.status === 'active'
                            ? 'en pausa por el plan'
                            : r.nextStep
                              ? `${r.nextStep.label} el ${day(r.nextStep.date)}`
                              : '—'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {canRemind && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={remind.isPending}
                            onClick={() => void doRemind(r)}
                          >
                            Recordar
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Más acciones">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canCharge && r.chargeable && (
                              <DropdownMenuItem onSelect={() => void doCharge(r)}>
                                Cobrar con su método guardado
                              </DropdownMenuItem>
                            )}
                            {canCharge && r.plan?.status !== 'active' && (
                              <DropdownMenuItem onSelect={() => setPlanFor(r)}>
                                Plan de pago…
                              </DropdownMenuItem>
                            )}
                            {hasCollections && canCase && r.contractId && !r.collectionsCase && (
                              <DropdownMenuItem onSelect={() => void doCase(r)}>
                                Abrir expediente de impago
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem asChild>
                              <Link href={`/customers/${r.customerId}`}>Ver ficha</Link>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {livePlans.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Planes de pago</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {livePlans.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-[180px] flex-1">
                    <Link
                      href={`/customers/${p.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {p.customerName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {p.invoiceNumbers.join(', ')} · creado el {day(p.createdAt)}
                      {p.createdByName && ` por ${p.createdByName}`}
                    </p>
                  </div>
                  <div className="w-56">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${Math.min(100, (p.paidSoFar / p.totalAmount) * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {eur(p.paidSoFar)} de {eur(p.totalAmount)} ·{' '}
                      {p.installments.filter((i) => i.status === 'paid').length}/
                      {p.installments.length} cuotas
                    </p>
                  </div>
                  <Badge variant={p.status === 'broken' ? 'destructive' : 'secondary'}>
                    {PLAN_STATUS[p.status]}
                  </Badge>
                  {canCharge && p.status === 'active' && (
                    <Button size="sm" variant="ghost" onClick={() => void doCancelPlan(p)}>
                      Cancelar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {planFor && (
        <PaymentPlanDialog
          open
          onOpenChange={(o) => !o && setPlanFor(null)}
          customerId={planFor.customerId}
          customerName={planFor.customerName}
          amount={planFor.amount}
          invoiceIds={planFor.invoiceIds}
        />
      )}
    </div>
  );
}
