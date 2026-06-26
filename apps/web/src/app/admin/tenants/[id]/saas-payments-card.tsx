'use client';

import { useEffect, useMemo, useState } from 'react';
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
  useAddManualPaymentDeps,
  useAddManualSaasPayment,
  useAdminTenantSaasPayments,
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
  const [manualOpen, setManualOpen] = useState(false);

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
                  {rows.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 whitespace-nowrap">{fmtDate(p.paidAt ?? p.createdAt)}</td>
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
                      <td className="p-2">
                        {p.invoiceUrl ? (
                          <a
                            href={p.invoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            Ver
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
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
  const { planPriceMonthly, planCurrency, periodEnd, hasStripe } =
    useAddManualPaymentDeps(tenantId);

  const [provider, setProvider] = useState<SaasPaymentProviderValue>('bank_transfer');
  const [amount, setAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [durationMonths, setDurationMonths] = useState(1);
  const [durationTouched, setDurationTouched] = useState(false);
  const [paidAt, setPaidAt] = useState('');
  const [description, setDescription] = useState('');

  const amountNum = Number(amount) || 0;

  // Propone la duración (importe ÷ precio mensual del plan) mientras el admin
  // no la haya editado a mano.
  const suggested = useMemo(() => {
    if (!planPriceMonthly || amountNum <= 0) return null;
    return Math.max(1, Math.round(amountNum / planPriceMonthly));
  }, [planPriceMonthly, amountNum]);

  useEffect(() => {
    if (!durationTouched && suggested) setDurationMonths(suggested);
  }, [suggested, durationTouched]);

  function reset() {
    setProvider('bank_transfer');
    setAmount('');
    setDiscount('');
    setDurationMonths(1);
    setDurationTouched(false);
    setPaidAt('');
    setDescription('');
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
        ...(paidAt ? { paidAt: new Date(`${paidAt}T12:00:00`).toISOString() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      toast.success('Pago registrado y periodo extendido.');
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
                onChange={(e) => {
                  setDurationTouched(true);
                  setDurationMonths(Math.max(1, Math.floor(Number(e.target.value) || 1)));
                }}
              />
              {suggested && !durationTouched ? (
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
          </div>
          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            Periodo actual hasta <span className="font-medium">{fmtDate(periodEnd)}</span> · tras el
            pago se extiende {durationMonths} mes(es).
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
