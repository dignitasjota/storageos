'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { SaasPaymentProviderValue } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchPlatformInvoicePdf,
  useAddManualPaymentDeps,
  useAddManualSaasPayment,
  useAdminTenantPlatformInvoices,
  useAdminTenantSaasPayments,
  useIssuePlatformInvoice,
  useSyncTenantSaasPayments,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : '—';
}

function fmtMoney(amount: number, currency: string): string {
  return amount.toLocaleString('es-ES', { style: 'currency', currency: currency || 'EUR' });
}

/** Periodo cubierto + duración legible (p. ej. "1 mes", "1 año"). */
function fmtPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  const months = Math.max(1, Math.round((e.getTime() - s.getTime()) / (30.4 * 24 * 3600 * 1000)));
  const dur = months >= 12 ? `${Math.round(months / 12)} año(s)` : `${months} mes(es)`;
  return `${fmtDate(start)} → ${fmtDate(end)} · ${dur}`;
}

const STATUS_LABELS: Record<string, string> = {
  paid: 'Pagado',
  failed: 'Fallido',
  pending: 'Pendiente',
  void: 'Anulado',
};

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  other: 'Otro',
};

const PROVIDER_OPTIONS: { value: SaasPaymentProviderValue; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'other', label: 'Otro' },
];

export function SaasPaymentsCard({ tenantId }: { tenantId: string }) {
  const payments = useAdminTenantSaasPayments(tenantId);
  const sync = useSyncTenantSaasPayments();
  const platformInvoices = useAdminTenantPlatformInvoices(tenantId);
  const issueInvoice = useIssuePlatformInvoice(tenantId);
  const invoiceByPayment = useMemo(
    () => new Map((platformInvoices.data ?? []).map((inv) => [inv.paymentId, inv])),
    [platformInvoices.data],
  );
  const [manualOpen, setManualOpen] = useState(false);

  async function onIssue(paymentId: string) {
    try {
      await issueInvoice.mutateAsync(paymentId);
      toast.success('Factura emitida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  async function onDownload(invoiceId: string) {
    try {
      const url = await fetchPlatformInvoicePdf(invoiceId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Sin PDF disponible');
    }
  }

  async function onSync() {
    try {
      const res = await sync.mutateAsync(tenantId);
      toast.success(`Sincronizados ${res.synced} pagos desde Stripe.`);
    } catch {
      toast.error('No se pudieron sincronizar los pagos.');
    }
  }

  const rows = payments.data ?? [];
  const totalPaid = rows.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Historial de pagos (suscripción)</CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSync} disabled={sync.isPending}>
            {sync.isPending ? 'Sincronizando…' : 'Sincronizar con Stripe'}
          </Button>
          <Button size="sm" onClick={() => setManualOpen(true)}>
            Añadir pago manual
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {payments.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin pagos registrados. Los cobros de Stripe se guardan aquí automáticamente; también
            puedes «Añadir pago manual» (efectivo, transferencia, PayPal…).
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Total cobrado:{' '}
              <span className="font-medium text-foreground">
                {fmtMoney(totalPaid, rows[0]?.currency ?? 'EUR')}
              </span>{' '}
              · {rows.length} pago(s)
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Fecha</th>
                    <th className="p-2">Origen</th>
                    <th className="p-2">Periodo</th>
                    <th className="p-2">Plan</th>
                    <th className="p-2 text-right">Importe</th>
                    <th className="p-2">Estado</th>
                    <th className="p-2">Factura</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const inv = invoiceByPayment.get(p.id);
                    const lines = inv?.lines ?? [];
                    return (
                      <Fragment key={p.id}>
                        <tr className="border-t">
                          <td className="p-2 whitespace-nowrap">
                            {fmtDate(p.paidAt ?? p.createdAt)}
                          </td>
                          <td className="p-2">{PROVIDER_LABELS[p.provider] ?? p.provider}</td>
                          <td className="p-2 text-xs text-muted-foreground">
                            {fmtPeriod(p.periodStart, p.periodEnd)}
                          </td>
                          <td className="p-2">{p.planName ?? p.planSlug ?? '—'}</td>
                          <td className="p-2 text-right tabular-nums">
                            {fmtMoney(p.amount, p.currency)}
                            {p.discount ? (
                              <span className="block text-xs text-muted-foreground">
                                −{fmtMoney(p.discount, p.currency)} desc.
                              </span>
                            ) : null}
                          </td>
                          <td className="p-2">{STATUS_LABELS[p.status] ?? p.status}</td>
                          <td className="space-x-2 p-2">
                            {p.invoiceUrl && (
                              <a
                                href={p.invoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                              >
                                Stripe
                              </a>
                            )}
                            {(() => {
                              if (inv) {
                                return (
                                  <button
                                    type="button"
                                    className="text-primary hover:underline"
                                    onClick={() => onDownload(inv.id)}
                                  >
                                    {inv.fullNumber}
                                  </button>
                                );
                              }
                              if (p.status === 'paid') {
                                return (
                                  <button
                                    type="button"
                                    className="text-muted-foreground hover:underline"
                                    disabled={issueInvoice.isPending}
                                    onClick={() => onIssue(p.id)}
                                  >
                                    Emitir
                                  </button>
                                );
                              }
                              return !p.invoiceUrl ? '—' : null;
                            })()}
                          </td>
                        </tr>
                        {lines.length > 1 && (
                          <tr className="bg-muted/20 text-xs text-muted-foreground">
                            <td className="px-2 pb-2" colSpan={7}>
                              <span className="mr-2 font-medium">Desglose:</span>
                              {lines.map((l, idx) => (
                                <span key={l.id} className="whitespace-nowrap">
                                  {idx > 0 && ' · '}
                                  {l.description}
                                  {l.quantity > 1 && ` ×${l.quantity}`} (
                                  {fmtMoney(l.total, inv?.currency ?? p.currency)})
                                </span>
                              ))}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>

      <AddManualPaymentDialog
        tenantId={tenantId}
        open={manualOpen}
        onClose={() => setManualOpen(false)}
      />
    </Card>
  );
}

function AddManualPaymentDialog({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const add = useAddManualSaasPayment(tenantId);
  const { planPriceMonthly, effectiveMonthly, planCurrency, periodEnd, hasStripe } =
    useAddManualPaymentDeps(tenantId);

  const [provider, setProvider] = useState<SaasPaymentProviderValue>('bank_transfer');
  const [amount, setAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [durationMonths, setDurationMonths] = useState(1);
  const [durationTouched, setDurationTouched] = useState(false);
  // Si el tenant paga el plan por Stripe, por defecto NO extendemos el periodo
  // (el pago manual será típicamente un add-on cobrado aparte).
  const [extendsPeriod, setExtendsPeriod] = useState(!hasStripe);
  const [extendsTouched, setExtendsTouched] = useState(false);
  const [paidAt, setPaidAt] = useState('');
  const [description, setDescription] = useState('');
  const [couponCode, setCouponCode] = useState('');

  const amountNum = Number(amount) || 0;

  useEffect(() => {
    if (!extendsTouched) setExtendsPeriod(!hasStripe);
  }, [hasStripe, extendsTouched]);

  // Propone la duración (importe ÷ importe mensual EFECTIVO = plan + add-ons)
  // mientras el admin no la haya editado. Usar el efectivo evita sobrestimar los
  // meses cuando hay add-ons (dividir por el plan a secas inflaba la duración).
  const monthlyRef = effectiveMonthly ?? planPriceMonthly;
  const suggested = useMemo(() => {
    if (!monthlyRef || amountNum <= 0) return null;
    return Math.max(1, Math.round(amountNum / monthlyRef));
  }, [monthlyRef, amountNum]);

  useEffect(() => {
    if (!durationTouched && suggested) setDurationMonths(suggested);
  }, [suggested, durationTouched]);

  function reset() {
    setProvider('bank_transfer');
    setAmount('');
    setDiscount('');
    setDurationMonths(1);
    setDurationTouched(false);
    setExtendsTouched(false);
    setPaidAt('');
    setDescription('');
    setCouponCode('');
  }

  function close() {
    reset();
    onClose();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (amountNum <= 0) {
      toast.error('Indica el importe cobrado.');
      return;
    }
    if (durationMonths < 1) {
      toast.error('La duración debe ser de al menos 1 mes.');
      return;
    }
    const discountNum = Number(discount) || 0;
    try {
      await add.mutateAsync({
        provider,
        amount: amountNum,
        ...(discountNum > 0 ? { discount: discountNum } : {}),
        currency: planCurrency,
        durationMonths,
        extendsPeriod,
        ...(paidAt ? { paidAt: new Date(`${paidAt}T12:00:00`).toISOString() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(couponCode.trim() ? { couponCode: couponCode.trim().toUpperCase() } : {}),
      });
      toast.success(
        extendsPeriod
          ? 'Pago registrado y periodo extendido.'
          : 'Cobro registrado (sin extender el periodo).',
      );
      close();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo registrar el pago.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Añadir pago manual</DialogTitle>
          <DialogDescription>
            Registra un pago de la suscripción (efectivo, transferencia, PayPal…). Extiende el
            periodo igual que un cobro de Stripe.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {hasStripe ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              Este tenant también se cobra por Stripe. Este pago se{' '}
              <strong>sumará por encima</strong> de la renovación de Stripe (no la pisa): el tiempo
              manual es un crédito permanente.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Origen</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as SaasPaymentProviderValue)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Importe ({planCurrency})</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="29.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Descuento (opcional)</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Duración (meses)</Label>
              <Input
                type="number"
                min={1}
                max={36}
                value={durationMonths}
                disabled={!extendsPeriod}
                onChange={(e) => {
                  setDurationTouched(true);
                  setDurationMonths(Math.max(1, Math.floor(Number(e.target.value) || 1)));
                }}
              />
              {suggested && !durationTouched && extendsPeriod ? (
                <p className="text-xs text-muted-foreground">Sugerido por importe: {suggested}.</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Fecha del pago</Label>
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Nota (opcional)</Label>
              <Textarea
                rows={1}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Nº de recibo, referencia…"
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs text-muted-foreground">Código de cupón (opcional)</Label>
              <Input
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="BLACKFRIDAY"
              />
              <p className="text-xs text-muted-foreground">
                Si es válido, el descuento se calcula en el servidor y se registra en el pago.
              </p>
            </div>
          </div>
          <label className="flex items-start gap-2 rounded-md border p-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!extendsPeriod}
              onChange={(e) => {
                setExtendsTouched(true);
                setExtendsPeriod(!e.target.checked);
              }}
            />
            <span>
              Solo cobro (no extender el periodo)
              <span className="block text-xs text-muted-foreground">
                Para un extra/add-on cobrado aparte cuando el tenant ya paga el plan por Stripe.
              </span>
            </span>
          </label>
          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            Periodo actual hasta <span className="font-medium">{fmtDate(periodEnd)}</span>
            {extendsPeriod
              ? ` · tras el pago se extiende ${durationMonths} mes(es).`
              : ' · el pago NO modifica el periodo (solo registra el ingreso + factura).'}
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Guardando…' : 'Registrar pago'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
