'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Download, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { AdminReceivableDto } from '@storageos/shared';

import { AddManualPaymentDialog } from '@/app/admin/tenants/[id]/saas-payments-card';
import { AdminError } from '@/components/admin/admin-error';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAdminReceivables,
  useChangePlan,
  useChargeAddon,
  useRemindReceivable,
  useSuspendTenant,
} from '@/lib/admin/hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { downloadCsv } from '@/lib/csv';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');
const METHOD: Record<string, string> = {
  stripe: 'Stripe',
  sepa: 'SEPA',
  redsys: 'Tarjeta (Redsys)',
  manual: 'Manual',
};
const PROVIDERS = [
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'other', label: 'Otro' },
];

/**
 * Cobros pendientes de los tenants a TrasterOS: cuotas impagadas (con el
 * escalado automático) y extras de pago manual sin cobrar. Desde aquí se
 * registra el pago, se cobra un extra, se suspende o se pasa a Free.
 */
export default function ReceivablesPage() {
  const data = useAdminReceivables();
  const [method, setMethod] = useState('all');
  const [kind, setKind] = useState('all');
  const [state, setState] = useState('all');
  const all = data.data?.items;
  const items = useMemo(
    () =>
      (all ?? []).filter(
        (i) =>
          (method === 'all' || i.method === method) &&
          (kind === 'all' || i.kind === kind) &&
          (state === 'all' ||
            (state === 'suspended'
              ? i.tenantStatus === 'suspended'
              : state === 'in_bank'
                ? !!i.overdue?.sepaInProgress
                : i.tenantStatus !== 'suspended' && !i.overdue?.sepaInProgress)),
      ),
    [all, method, kind, state],
  );
  if (data.isError) return <AdminError onRetry={() => void data.refetch()} />;
  const filtered = method !== 'all' || kind !== 'all' || state !== 'all';
  // Lo que ya va en una remesa SEPA está en el banco: no cuenta como pendiente.
  const owed = items.filter((i) => !i.overdue?.sepaInProgress);
  const old = owed.filter((i) => i.days > 15).length;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cobros pendientes</h1>
        <p className="text-sm text-muted-foreground">
          Cuotas impagadas y extras de pago manual sin cobrar, de más antiguo a más reciente.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="Pendiente de cobro"
          value={eur(
            filtered ? owed.reduce((sum, i) => sum + i.amount, 0) : (data.data?.total ?? 0),
          )}
        />
        <Kpi label="Cobros pendientes" value={String(owed.length)} />
        <Kpi label="Con más de 15 días" value={String(old)} warn={old > 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Filter
          value={method}
          onChange={setMethod}
          options={[
            ['all', 'Todas las formas de cobro'],
            ['manual', 'Manual'],
            ['sepa', 'SEPA'],
            ['redsys', 'Tarjeta (Redsys)'],
            ['stripe', 'Stripe'],
          ]}
        />
        <Filter
          value={kind}
          onChange={setKind}
          options={[
            ['all', 'Cuotas y extras'],
            ['subscription', 'Solo cuotas'],
            ['addon', 'Solo extras'],
          ]}
        />
        <Filter
          value={state}
          onChange={setState}
          options={[
            ['all', 'Cualquier estado'],
            ['owed', 'Pendientes'],
            ['in_bank', 'En una remesa SEPA'],
            ['suspended', 'Suspendidos'],
          ]}
        />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={items.length === 0}
          onClick={() =>
            downloadCsv('cobros-pendientes.csv', [
              [
                'Tenant',
                'Concepto',
                'Forma de cobro',
                'Importe',
                'Cuotas',
                'Desde',
                'Días',
                'Estado',
              ],
              ...items.map((i) => [
                i.tenantName,
                i.concept,
                METHOD[i.method] ?? i.method,
                i.amount,
                i.overdue?.periods ?? 1,
                day(i.since),
                i.days,
                i.overdue?.sepaInProgress
                  ? 'En remesa SEPA'
                  : i.tenantStatus === 'suspended'
                    ? 'Suspendido'
                    : 'Pendiente',
              ]),
            ])
          }
        >
          <Download className="mr-2 size-4" />
          CSV
        </Button>
      </div>

      {data.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {filtered ? 'Nada con estos filtros.' : 'Nadie debe nada. 🎉'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((i) => (
            <ReceivableRow key={`${i.kind}-${i.tenantAddonId ?? i.tenantId}`} item={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReceivableRow({ item: i }: { item: AdminReceivableDto }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const canEdit = useIsSuperadmin();
  const charge = useChargeAddon();
  const suspend = useSuspendTenant();
  const changePlan = useChangePlan();
  const remind = useRemindReceivable();
  const [payOpen, setPayOpen] = useState(false);

  async function run(p: Promise<unknown>, ok: string) {
    try {
      await p;
      toast.success(ok);
      void qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo hacer.');
    }
  }

  async function doSuspend() {
    const res = await ask({
      title: `Suspender ${i.tenantName}`,
      description:
        'Su panel queda en solo lectura, no se cobra a sus inquilinos y su web deja de aceptar reservas hasta que pague.',
      input: { label: 'Motivo' },
      confirmLabel: 'Suspender',
      destructive: true,
    });
    if (!res) return;
    await run(
      suspend.mutateAsync({
        id: i.tenantId,
        input: { reason: res.value || 'Impago', churnReason: 'nonpayment' },
      }),
      'Tenant suspendido.',
    );
  }

  async function toFree() {
    const res = await ask({
      title: `Pasar ${i.tenantName} al plan Free`,
      description: 'Deja de deber la cuota y pierde las funciones de pago.',
      input: { label: 'Motivo' },
      confirmLabel: 'Pasar a Free',
      destructive: true,
    });
    if (!res) return;
    await run(
      changePlan.mutateAsync({
        id: i.tenantId,
        input: { planSlug: 'free', reason: res.value || 'Impago' },
      }),
      'Pasado al plan Free.',
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/tenants/${i.tenantId}?tab=payments`}
              className="font-medium hover:underline"
            >
              {i.tenantName}
            </Link>
            {i.tenantStatus === 'suspended' && (
              <Badge variant="destructive">{tenantStatusLabel(i.tenantStatus)}</Badge>
            )}
            <Badge variant="outline">{METHOD[i.method] ?? i.method}</Badge>
          </div>
          <p className="text-sm">
            {i.concept} · <span className="font-semibold">{eur(i.amount)}</span>
            {i.overdue && i.overdue.periods > 1 && (
              <span className="text-muted-foreground">
                {' '}
                ({i.overdue.periods} cuotas de {eur(i.overdue.periodAmount)})
              </span>
            )}
          </p>
          <p className={`text-xs ${i.days > 15 ? 'text-destructive' : 'text-muted-foreground'}`}>
            Desde el {day(i.since)} ({i.days} {i.days === 1 ? 'día' : 'días'})
          </p>
          {i.overdue && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {i.overdue.sepaInProgress && <p>Adeudo SEPA en el banco (el escalado espera).</p>}
              {i.overdue.sepaBounced && (
                <p className="text-destructive">El último adeudo SEPA se devolvió.</p>
              )}
              {i.overdue.steps.length > 0 && (
                <ol className="flex flex-wrap gap-x-3 gap-y-1">
                  {i.overdue.steps.map((s) => (
                    <li key={s.step} className="flex items-center gap-1">
                      {s.doneAt ? (
                        <CheckCircle2 className="size-3.5 text-destructive" />
                      ) : (
                        <Circle className="size-3.5" />
                      )}
                      {s.label} {s.doneAt ? `(${day(s.doneAt)})` : `el ${day(s.date)}`}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {i.kind === 'addon' && i.tenantAddonId ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={!canEdit || charge.isPending}>
                  Cobrar
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {PROVIDERS.map((p) => (
                  <DropdownMenuItem
                    key={p.value}
                    onSelect={() =>
                      void run(
                        charge.mutateAsync({ tenantAddonId: i.tenantAddonId!, provider: p.value }),
                        'Cobro registrado.',
                      )
                    }
                  >
                    {p.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" disabled={!canEdit} onClick={() => setPayOpen(true)}>
              Registrar pago
            </Button>
          )}
          {i.kind === 'subscription' && !i.overdue?.sepaInProgress && (
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || remind.isPending}
              onClick={async () => {
                try {
                  const r = await remind.mutateAsync(i.tenantId);
                  toast.success(
                    r.recipients > 0
                      ? `Recordatorio enviado a ${r.recipients} ${r.recipients === 1 ? 'dirección' : 'direcciones'}.`
                      : 'No tiene a quién enviarlo: falta un email de facturación o un propietario verificado.',
                  );
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
                }
              }}
            >
              Enviar recordatorio
            </Button>
          )}
          {i.kind === 'subscription' && i.tenantStatus !== 'suspended' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void doSuspend()}
              disabled={!canEdit}
            >
              Suspender
            </Button>
          )}
          {i.kind === 'subscription' && (
            <Button size="sm" variant="ghost" onClick={() => void toFree()} disabled={!canEdit}>
              Pasar a Free
            </Button>
          )}
        </div>
      </CardContent>
      {i.kind === 'subscription' && (
        <AddManualPaymentDialog
          tenantId={i.tenantId}
          open={payOpen}
          onClose={() => {
            setPayOpen(false);
            void qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
          }}
          defaultAmount={i.amount}
          {...(i.overdue ? { periodAmount: i.overdue.periodAmount } : {})}
        />
      )}
    </Card>
  );
}

function Filter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-auto min-w-[10rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold ${warn ? 'text-destructive' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
