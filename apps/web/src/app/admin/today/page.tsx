'use client';

import { AlertTriangle, CalendarClock, CreditCard, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminAddonChargeDueDto, SaasPaymentProviderValue } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAddonSuspension, useAdminToday, useChargeAddon } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number, c = 'EUR') =>
  n.toLocaleString('es-ES', { style: 'currency', currency: c || 'EUR' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

const PROVIDERS: { value: SaasPaymentProviderValue; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'other', label: 'Otro' },
];

export default function AdminTodayPage() {
  const today = useAdminToday();
  const data = today.data;

  if (today.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const nothing =
    data &&
    data.addonCharges.length === 0 &&
    data.pastDue.length === 0 &&
    data.trialsExpiring.length === 0 &&
    data.followupsDue.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hoy</h1>
        <p className="text-sm text-muted-foreground">
          {data ? new Date(data.date).toLocaleDateString('es-ES', { dateStyle: 'full' }) : ''}
          {data && data.urgentCount > 0 ? ` · ${data.urgentCount} acción(es) pendiente(s)` : ''}
        </p>
      </div>

      {nothing && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nada pendiente hoy. 🎉
          </CardContent>
        </Card>
      )}

      {/* Cobros de add-ons pendientes */}
      {data && data.addonCharges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="size-4 text-amber-500" />
              Cobros de add-ons pendientes ({data.addonCharges.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Add-ons de tenants que pagan el plan por Stripe: cóbralos a mano cada mes. Registrar
              el cobro no toca el periodo del plan y reprograma el siguiente en un mes.
            </p>
            {data.addonCharges.map((c) => (
              <AddonChargeRow key={c.tenantAddonId} charge={c} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Pagos fallidos */}
      {data && data.pastDue.length > 0 && (
        <SimpleCard
          title={`Pagos fallidos (${data.pastDue.length})`}
          icon={<AlertTriangle className="size-4 text-red-500" />}
        >
          {data.pastDue.map((t) => (
            <TenantRow key={t.id} id={t.id} name={t.name} detail={t.detail ?? 'Pago fallido'} />
          ))}
        </SimpleCard>
      )}

      {/* Trials por expirar */}
      {data && data.trialsExpiring.length > 0 && (
        <SimpleCard
          title={`Trials por expirar (${data.trialsExpiring.length})`}
          icon={<CalendarClock className="size-4 text-amber-500" />}
        >
          {data.trialsExpiring.map((t) => (
            <TenantRow
              key={t.id}
              id={t.id}
              name={t.name}
              detail={t.since ? `Expira ${fmtDate(t.since)}` : 'Trial'}
            />
          ))}
        </SimpleCard>
      )}

      {/* Seguimientos vencidos */}
      {data && data.followupsDue.length > 0 && (
        <SimpleCard
          title={`Seguimientos vencidos (${data.followupsDue.length})`}
          icon={<CalendarClock className="size-4 text-amber-500" />}
        >
          {data.followupsDue.map((f) => (
            <TenantRow
              key={f.id}
              id={f.tenantId}
              name={f.tenantName ?? '—'}
              detail={`${f.title} · vence ${fmtDate(f.dueDate)}`}
            />
          ))}
        </SimpleCard>
      )}
    </div>
  );
}

function AddonChargeRow({ charge }: { charge: AdminAddonChargeDueDto }) {
  const chargeAddon = useChargeAddon();
  const suspend = useAddonSuspension(charge.tenantId, 'suspend');
  const [provider, setProvider] = useState<SaasPaymentProviderValue>('cash');

  async function onCharge() {
    try {
      await chargeAddon.mutateAsync({ tenantAddonId: charge.tenantAddonId, provider });
      toast.success('Cobro registrado. Siguiente cobro en un mes.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar el cobro.');
    }
  }
  async function onSuspend() {
    try {
      await suspend.mutateAsync(charge.tenantAddonId);
      toast.success('Add-on suspendido por impago.');
    } catch {
      toast.error('No se pudo suspender.');
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
      <div className="min-w-0">
        <Link href={`/admin/tenants/${charge.tenantId}`} className="font-medium hover:underline">
          {charge.tenantName}
        </Link>
        <span className="text-muted-foreground"> · {charge.addonName}</span>
        {charge.overdueDays > 0 && (
          <span className="ml-1 text-xs text-red-500">(+{charge.overdueDays} d)</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-semibold tabular-nums">{eur(charge.amount, charge.currency)}</span>
        <Select value={provider} onValueChange={(v) => setProvider(v as SaasPaymentProviderValue)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={onCharge} disabled={chargeAddon.isPending}>
          Registrar cobro
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-amber-600 hover:text-amber-700"
          onClick={onSuspend}
          disabled={suspend.isPending}
        >
          Suspender
        </Button>
      </div>
    </div>
  );
}

function SimpleCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function TenantRow({ id, name, detail }: { id: string; name: string; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
      <Link href={`/admin/tenants/${id}`} className="font-medium hover:underline">
        {name}
      </Link>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}
