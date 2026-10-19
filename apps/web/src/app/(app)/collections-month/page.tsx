'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import type { MonthCollectionsItemDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useBulkChargeInvoices, useBulkRemindInvoices } from '@/lib/billing/hooks';
import { useMonthCollections } from '@/lib/collections-ops/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('es-ES');

const METHOD: Record<string, string> = {
  card: 'Tarjeta',
  sepa_debit: 'Adeudo SEPA',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  bizum: 'Bizum',
  other: 'Otros',
};

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shift(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'red' | 'amber' | 'green';
}) {
  const color =
    tone === 'red'
      ? 'text-destructive'
      : tone === 'amber'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'green'
          ? 'text-emerald-700 dark:text-emerald-400'
          : '';
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-xl font-semibold tabular-nums ${color}`}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Cobros del mes: lo que vence este mes por cómo se cobra (solo, por remesa o a
 * mano), lo cobrado, lo que falló o se devolvió, y lo que hay que reclamar.
 */
export default function CollectionsMonthPage() {
  const [month, setMonth] = useState(thisMonth());
  const facilityId = useHeaderFacilityId();
  const data = useMonthCollections(month, facilityId);
  const charge = useBulkChargeInvoices();
  const remind = useBulkRemindInvoices();
  const canCharge = useHasPermission('payments:charge');
  const canRemind = useHasPermission('communications:send');
  const d = data.data;
  const rawLabel = new Date(`${month}-01T12:00:00`).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
  });
  const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);

  async function retry(item: MonthCollectionsItemDto) {
    try {
      const res = await charge.mutateAsync([item.invoiceId]);
      if (res.succeeded.length) toast.success(`Cobro de ${item.invoiceNumber} lanzado.`);
      else toast.error(res.failed[0]?.error ?? 'No se pudo cobrar.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cobrar.');
    }
  }
  async function remindAll(items: MonthCollectionsItemDto[]) {
    try {
      const res = await remind.mutateAsync(items.map((i) => i.invoiceId));
      toast.success(`Recordatorio enviado a ${res.succeeded.length} factura(s).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cobros del mes</h1>
          <p className="text-sm text-muted-foreground">
            Lo que vence en el mes, cómo se cobra y lo que queda por cobrar.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Mes anterior"
            onClick={() => setMonth(shift(month, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">{label}</span>
          <Button
            variant="outline"
            size="icon"
            aria-label="Mes siguiente"
            onClick={() => setMonth(shift(month, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {data.isLoading || !d ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Previsto (vence este mes)"
              value={eur(d.expected.total.amount)}
              hint={`${d.expected.total.count} facturas`}
            />
            <Tile
              label="Cobrado en el mes"
              value={eur(d.collected.amount)}
              tone="green"
              hint={`${d.collected.count} cobros`}
            />
            <Tile
              label="Pendiente de lo previsto"
              value={eur(d.outstanding.amount)}
              tone={d.outstanding.amount > 0 ? 'amber' : undefined}
              hint={`${d.outstanding.count} facturas`}
            />
            <Tile
              label="Fallidos y devueltos"
              value={eur(d.failed.amount + d.returned.amount)}
              tone={d.failed.count + d.returned.count > 0 ? 'red' : undefined}
              hint={`${d.failed.count} fallidos · ${d.returned.count} devueltos`}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Por semana</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 300, height: 256 }}
                >
                  <BarChart data={d.weeks}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" fontSize={12} />
                    <YAxis fontSize={12} width={60} />
                    <Tooltip formatter={(v) => eur(Number(v))} />
                    <Legend />
                    <Bar dataKey="expected" name="Vence" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="collected" name="Cobrado" fill="#2563eb" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cómo se cobra lo previsto</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(
                  [
                    ['auto', 'Solo (tarjeta o adeudo guardados)'],
                    ['remittance', 'Remesa SEPA'],
                    ['manual', 'A mano'],
                  ] as const
                ).map(([k, l]) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-muted-foreground">{l}</span>
                    <span className="tabular-nums">
                      {eur(d.expected[k].amount)}{' '}
                      <span className="text-xs text-muted-foreground">({d.expected[k].count})</span>
                    </span>
                  </div>
                ))}
                <div className="border-t pt-2 text-xs font-medium text-muted-foreground">
                  Cobrado por forma de pago
                </div>
                {Object.entries(d.collected.byMethod).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-muted-foreground">{METHOD[k] ?? k}</span>
                    <span className="tabular-nums">{eur(v)}</span>
                  </div>
                ))}
                {Object.keys(d.collected.byMethod).length === 0 && (
                  <p className="text-xs text-muted-foreground">Aún no hay cobros este mes.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <ItemsCard
            title="Cobros fallidos"
            empty="Ningún cobro ha fallado este mes."
            items={d.failed.items}
            action={
              canCharge
                ? { label: 'Reintentar', onClick: (i) => void retry(i), disabled: charge.isPending }
                : undefined
            }
          />
          <ItemsCard
            title="Recibos devueltos"
            empty="Ningún recibo devuelto este mes."
            items={d.returned.items}
          />
          <ItemsCard
            title="Pendiente de cobro a mano"
            empty="Nada pendiente de cobro a mano."
            items={d.manualPending}
            headerAction={
              canRemind && d.manualPending.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remind.isPending}
                  onClick={() => void remindAll(d.manualPending)}
                >
                  Recordar a todos
                </Button>
              ) : undefined
            }
          />
        </>
      )}
    </div>
  );
}

function ItemsCard({
  title,
  empty,
  items,
  action,
  headerAction,
}: {
  title: string;
  empty: string;
  items: MonthCollectionsItemDto[];
  action?: { label: string; onClick: (i: MonthCollectionsItemDto) => void; disabled?: boolean };
  headerAction?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {title}{' '}
          {items.length > 0 && <span className="text-muted-foreground">({items.length})</span>}
        </CardTitle>
        {headerAction}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((i) => (
              <li
                key={`${i.invoiceId}-${i.date}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  {i.customerId ? (
                    <Link
                      href={`/customers/${i.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {i.customerName}
                    </Link>
                  ) : (
                    <span className="font-medium">{i.customerName}</span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    <Link href={`/invoices/${i.invoiceId}`} className="hover:underline">
                      {i.invoiceNumber}
                    </Link>{' '}
                    · {day(i.date)}
                    {i.reason && ` · ${i.reason}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">{eur(i.amount)}</span>
                  {action && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.disabled}
                      onClick={() => action.onClick(i)}
                    >
                      {action.label}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
