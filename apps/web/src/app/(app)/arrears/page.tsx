'use client';

import { ChevronDown, Download, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { ArrearsRowDto, PaymentPlanDto } from '@storageos/shared';

import { AccessCutsCard } from '@/components/billing/access-cuts-card';
import { DebtorPaymentDialog } from '@/components/billing/debtor-payment-dialog';
import { PaymentPlanDialog } from '@/components/billing/payment-plan-dialog';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { PhoneLinks, SnoozeMenu } from '@/components/dashboard/today-actions';
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
import { downloadCsv } from '@/lib/csv';
import { useUnsnoozeToday } from '@/lib/dashboard/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';

const eur = formatEur;
const day = (iso: string) => formatDate(iso.length === 10 ? `${iso}T12:00:00` : iso);

const PLAN_STATUS: Record<string, string> = {
  active: 'Al día',
  broken: 'Incumplido',
  completed: 'Pagado',
  cancelled: 'Cancelado',
};

const INSTALLMENT_STATUS: Record<string, { label: string; className: string }> = {
  paid: { label: 'Pagada', className: 'text-emerald-700 dark:text-emerald-400' },
  partial: { label: 'A medias', className: 'text-amber-700 dark:text-amber-400' },
  pending: { label: 'Pendiente', className: 'text-muted-foreground' },
  late: { label: 'Atrasada', className: 'text-destructive' },
};

type Filter = 'all' | 'actionable' | 'in_flight' | 'plan' | 'no_method' | 'snoozed';

const FILTERS: { value: Filter; label: string; test: (r: ArrearsRowDto) => boolean }[] = [
  { value: 'all', label: 'Todos', test: () => true },
  { value: 'actionable', label: 'Por reclamar', test: (r) => isActionable(r) },
  { value: 'in_flight', label: 'Cobrándose', test: (r) => !!r.paymentInFlight },
  {
    value: 'plan',
    label: 'Con plan de pago',
    test: (r) => r.plan?.status === 'active' || r.plan?.status === 'broken',
  },
  { value: 'no_method', label: 'Sin forma de pago', test: (r) => !r.chargeable && !r.sepaMandate },
  { value: 'snoozed', label: 'Apartados', test: (r) => !!r.snoozed },
];

/** Lo mismo que cuenta el API como «por reclamar». */
function isActionable(r: ArrearsRowDto): boolean {
  return !r.paymentInFlight && r.plan?.status !== 'active' && !r.snoozed;
}

/** En qué punto está el cobro, en palabras (para la fila y el CSV). */
function collectionState(r: ArrearsRowDto): string {
  if (r.paymentInFlight === 'remittance') return 'Va en una remesa SEPA';
  if (r.paymentInFlight === 'charge') return 'Cobro en curso';
  if (r.plan?.status === 'active') return 'Plan de pago al día';
  if (r.plan?.status === 'broken') return 'Plan de pago incumplido';
  if (r.snoozed) return `Apartado hasta el ${day(r.snoozed.until)}`;
  return 'Por reclamar';
}

function nextStepText(r: ArrearsRowDto): string {
  if (r.plan?.status === 'active') return 'en pausa por el plan';
  if (r.paymentInFlight) return 'en pausa mientras se cobra';
  if (!r.nextStep) return '—';
  return r.nextStep.postponed
    ? `${r.nextStep.label} (aplazado)`
    : `${r.nextStep.label} el ${day(r.nextStep.date)}`;
}

/** El mensaje de WhatsApp para reclamar: importe y dónde pagarlo. */
function whatsappMessage(r: ArrearsRowDto, portalUrl: string): string {
  const first = r.customerName.split(' ')[0] ?? '';
  const facturas =
    r.invoiceCount === 1 ? '1 factura vencida' : `${r.invoiceCount} facturas vencidas`;
  return [
    `Hola${first ? ` ${first}` : ''}, tienes pendiente de pago ${eur(r.amount)} (${facturas}).`,
    portalUrl ? `Puedes pagarlo desde tu área de clientes: ${portalUrl}` : '',
    'Si ya lo has pagado, dínoslo y lo revisamos. Gracias.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Deudores: un inquilino por fila con lo que debe, desde cuándo, en qué paso
 * del escalado va y si tiene plan de pago o expediente; con las acciones para
 * reclamarlo (llamar, WhatsApp, recordar, registrar un pago, cobrar, plan de
 * pago, expediente, apartar unos días).
 */
export default function ArrearsPage() {
  const facilityId = useHeaderFacilityId();
  const arrears = useArrears(facilityId);
  const plans = usePaymentPlans(facilityId ? { facilityId } : {});
  const remind = useBulkRemindInvoices();
  const charge = useBulkChargeInvoices();
  const openCase = useOpenCase();
  const cancelPlan = useCancelPaymentPlan();
  const unsnooze = useUnsnoozeToday();
  const ask = useConfirm();
  const canCharge = useHasPermission('payments:charge');
  const canPay = useHasPermission('invoices:write');
  const canRemind = useHasPermission('communications:send');
  const canCase = useHasPermission('collections:manage');
  const hasCollections = useHasFeature('collections');
  const [planFor, setPlanFor] = useState<ArrearsRowDto | null>(null);
  const [payFor, setPayFor] = useState<ArrearsRowDto | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [openPlans, setOpenPlans] = useState<Set<string>>(new Set());
  const d = arrears.data;
  const livePlans = (plans.data ?? []).filter(
    (p) => p.status === 'active' || p.status === 'broken',
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.value, (d?.rows ?? []).filter(f.test).length]),
      ) as Record<Filter, number>,
    [d],
  );
  const rows = useMemo(
    () => (d?.rows ?? []).filter(FILTERS.find((f) => f.value === filter)!.test),
    [d, filter],
  );

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  async function doRemind(r: ArrearsRowDto) {
    try {
      const res = await remind.mutateAsync(r.invoiceIds);
      if (res.succeeded.length === 0) {
        toast.error(res.failed[0]?.error ?? 'No se ha enviado ningún recordatorio.');
        return;
      }
      toast.success(
        `Recordatorio enviado a ${r.customerName} (${res.succeeded.length} ${res.succeeded.length === 1 ? 'factura' : 'facturas'}).${
          res.failed.length > 0 ? ` ${res.failed.length} no: ${res.failed[0]!.error}` : ''
        }`,
      );
      void arrears.refetch();
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
        toast.error(
          `${res.failed.length === 1 ? 'Un cobro no se pudo hacer' : `${res.failed.length} cobros no se pudieron hacer`}: ${res.failed[0]!.error}`,
        );
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
  async function doUnsnooze(r: ArrearsRowDto) {
    if (!r.snoozed) return;
    try {
      await unsnooze.mutateAsync(r.snoozed.id);
      toast.success(`${r.customerName} vuelve a la lista de por reclamar.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  function exportCsv() {
    downloadCsv(`deudores-${new Date().toISOString().slice(0, 10)}.csv`, [
      [
        'Inquilino',
        'Email',
        'Teléfono',
        'Trasteros',
        'Debe (€)',
        'Facturas',
        'Vencida desde',
        'Días',
        'Último aviso',
        'Siguiente paso',
        'Estado del cobro',
        'Expediente',
      ],
      ...rows.map((r) => [
        r.customerName,
        r.email ?? '',
        r.phone ?? '',
        r.units.join(', '),
        r.amount,
        r.invoices.map((i) => i.invoiceNumber).join(', '),
        day(r.since),
        r.days,
        r.lastReminderAt ? day(r.lastReminderAt) : '',
        nextStepText(r),
        collectionState(r),
        r.collectionsCase ? 'Sí' : 'No',
      ]),
    ]);
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deudores</h1>
          <p className="text-sm text-muted-foreground">
            Inquilinos con facturas vencidas, en qué punto está cada uno y qué hacer.
          </p>
        </div>
        {d && d.rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-1 size-4" /> Descargar CSV
          </Button>
        )}
      </div>

      {arrears.isError ? (
        <SectionError onRetry={() => void arrears.refetch()} />
      ) : arrears.isLoading || !d ? (
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
                  {d.actionable !== d.customers &&
                    ` · ${d.actionable} por reclamar (el resto ya está pagando, tiene plan o está apartado)`}
                </p>
              </CardContent>
            </Card>
            {d.aging.map((a) => (
              <Card key={a.label}>
                <CardContent className="space-y-1 p-4">
                  <p className="text-xs text-muted-foreground">{a.label}</p>
                  <p className="text-lg font-semibold tabular-nums">{eur(a.amount)}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.count} {a.count === 1 ? 'factura' : 'facturas'}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <AccessCutsCard facilityId={facilityId} />

          {d.rows.length > 0 && (
            // En el móvil, una tira que se desliza en vez de varias filas de botones.
            <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
              {FILTERS.map((f) => (
                <Button
                  key={f.value}
                  size="sm"
                  className="shrink-0"
                  variant={filter === f.value ? 'default' : 'outline'}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                  <span className="ml-1 tabular-nums opacity-70">{counts[f.value]}</span>
                </Button>
              ))}
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              {d.rows.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Nadie debe nada. 🎉</p>
              ) : rows.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Nadie en este filtro.{' '}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => setFilter('all')}
                  >
                    Ver todos
                  </button>
                </p>
              ) : (
                <ul className="divide-y">
                  {rows.map((r) => {
                    const expanded = openRows.has(r.customerId);
                    return (
                      <li key={r.customerId} className="space-y-2 p-4">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-[180px] flex-1">
                            <Link
                              href={`/customers/${r.customerId}`}
                              className="font-medium hover:underline"
                            >
                              {r.customerName}
                            </Link>
                            <p className="text-xs text-muted-foreground">
                              {[r.units.join(', ') || 'Sin trastero', r.phone, r.email]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {r.paymentInFlight && (
                                <Badge className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                                  {r.paymentInFlight === 'remittance'
                                    ? 'Va en una remesa SEPA'
                                    : 'Cobro en curso'}
                                </Badge>
                              )}
                              {r.snoozed && (
                                <Badge variant="secondary">
                                  Apartado hasta el {day(r.snoozed.until)}
                                </Badge>
                              )}
                              {r.chargeable && (
                                <Badge variant="outline">Tiene tarjeta/adeudo</Badge>
                              )}
                              {r.sepaMandate && <Badge variant="outline">Con mandato SEPA</Badge>}
                              {!r.chargeable && !r.sepaMandate && (
                                <Badge variant="outline">Sin forma de pago guardada</Badge>
                              )}
                              {r.lateFeeApplied && <Badge variant="outline">Con recargo</Badge>}
                              {r.accessBlocked && (
                                <Badge variant="destructive">Acceso cortado</Badge>
                              )}
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
                            <button
                              type="button"
                              className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                              aria-expanded={expanded}
                              onClick={() => setOpenRows((s) => toggle(s, r.customerId))}
                            >
                              {r.invoiceCount} {r.invoiceCount === 1 ? 'factura' : 'facturas'} ·{' '}
                              {r.days} {r.days === 1 ? 'día' : 'días'}
                              <ChevronDown
                                className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                              />
                            </button>
                          </div>
                          <div className="w-48 text-xs text-muted-foreground">
                            <p>
                              Último aviso: {r.lastReminderAt ? day(r.lastReminderAt) : 'ninguno'}
                            </p>
                            <p>Siguiente: {nextStepText(r)}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <PhoneLinks phone={r.phone} message={whatsappMessage(r, d.portalUrl)} />
                            {canRemind && !r.paymentInFlight && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={remind.isPending}
                                onClick={() => void doRemind(r)}
                              >
                                Recordar
                              </Button>
                            )}
                            {r.snoozed ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={unsnooze.isPending}
                                onClick={() => void doUnsnooze(r)}
                              >
                                Volver a mostrar
                              </Button>
                            ) : (
                              <SnoozeMenu
                                kind="customer_debt"
                                refId={r.customerId}
                                label={r.customerName}
                              />
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Más acciones">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canPay && !r.paymentInFlight && (
                                  <DropdownMenuItem onSelect={() => setPayFor(r)}>
                                    Pago recibido…
                                  </DropdownMenuItem>
                                )}
                                {canCharge && r.chargeable && !r.paymentInFlight && (
                                  <DropdownMenuItem onSelect={() => void doCharge(r)}>
                                    Cobrar con su método guardado
                                  </DropdownMenuItem>
                                )}
                                {canCharge && r.plan?.status !== 'active' && (
                                  <DropdownMenuItem onSelect={() => setPlanFor(r)}>
                                    Plan de pago…
                                  </DropdownMenuItem>
                                )}
                                {hasCollections &&
                                  canCase &&
                                  r.contractId &&
                                  !r.collectionsCase && (
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
                        </div>
                        {expanded && (
                          <ul className="ml-0 space-y-1 rounded-md bg-muted/50 p-3 text-xs sm:ml-4">
                            {r.invoices.map((i) => (
                              <li key={i.id} className="flex flex-wrap justify-between gap-2">
                                <Link href={`/invoices/${i.id}`} className="hover:underline">
                                  {i.invoiceNumber}
                                </Link>
                                <span className="text-muted-foreground">
                                  {i.dueDate ? `venció el ${day(i.dueDate)}` : 'sin vencimiento'}
                                </span>
                                <span className="tabular-nums">{eur(i.pending)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
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
              {livePlans.map((p) => {
                const expanded = openPlans.has(p.id);
                const paidCount = p.installments.filter((i) => i.status === 'paid').length;
                return (
                  <li key={p.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-3">
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
                            style={{
                              width: `${Math.min(100, (p.paidSoFar / p.totalAmount) * 100)}%`,
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          className="mt-1 flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                          aria-expanded={expanded}
                          onClick={() => setOpenPlans((s) => toggle(s, p.id))}
                        >
                          {eur(p.paidSoFar)} de {eur(p.totalAmount)} · {paidCount}/
                          {p.installments.length} {p.installments.length === 1 ? 'cuota' : 'cuotas'}
                          <ChevronDown
                            className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                          />
                        </button>
                      </div>
                      <Badge variant={p.status === 'broken' ? 'destructive' : 'secondary'}>
                        {PLAN_STATUS[p.status]}
                      </Badge>
                      {canCharge && p.status === 'active' && (
                        <Button size="sm" variant="ghost" onClick={() => void doCancelPlan(p)}>
                          Cancelar
                        </Button>
                      )}
                    </div>
                    {expanded && (
                      <table className="w-full max-w-xl text-xs">
                        <thead className="text-left text-muted-foreground">
                          <tr>
                            <th className="py-1 font-normal">Cuota</th>
                            <th className="py-1 font-normal">Vence</th>
                            <th className="py-1 text-right font-normal">Importe</th>
                            <th className="py-1 text-right font-normal">Pagado</th>
                            <th className="py-1 text-right font-normal">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.installments.map((i, k) => (
                            <tr key={i.dueDate + k} className="border-t">
                              <td className="py-1">{k + 1}</td>
                              <td className="py-1">{day(i.dueDate)}</td>
                              <td className="py-1 text-right tabular-nums">{eur(i.amount)}</td>
                              <td className="py-1 text-right tabular-nums">{eur(i.paid)}</td>
                              <td
                                className={`py-1 text-right ${INSTALLMENT_STATUS[i.status]?.className ?? ''}`}
                              >
                                {INSTALLMENT_STATUS[i.status]?.label ?? i.status}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </li>
                );
              })}
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
      {payFor && <DebtorPaymentDialog row={payFor} onOpenChange={(o) => !o && setPayFor(null)} />}
    </div>
  );
}
