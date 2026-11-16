'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { ReferralDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDate, formatEur } from '@/lib/format';
import {
  useReferrals,
  useReferralSettings,
  useReferralStats,
  useReferralTop,
  useUpdateReferralSettings,
} from '@/lib/referrals/hooks';

const STATUS: Record<
  ReferralDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  pending: { label: 'Pendiente de su primer pago', variant: 'secondary' },
  converted: { label: 'Ya es cliente', variant: 'default' },
  cancelled: { label: 'No llegó a ser cliente', variant: 'outline' },
};

/** Qué pasa con la recompensa de quien recomendó. */
function rewardText(r: ReferralDto): { main: string; note: string } | null {
  const reward = r.reward;
  if (!reward) {
    return r.rewardSkippedReason === 'yearly_cap'
      ? { main: 'Sin recompensa', note: 'ya ha llegado al tope de este año' }
      : null;
  }
  const main = reward.type === 'percentage' ? `${reward.value} %` : formatEur(reward.value);
  if (reward.appliedAt) {
    return {
      main,
      note: `descontado${reward.invoiceNumber ? ` en ${reward.invoiceNumber}` : ''}`,
    };
  }
  if (!r.referrerActive) {
    return { main, note: 'sin descontar: quien recomendó ya no tiene contrato' };
  }
  if (reward.type === 'fixed' && reward.appliedAmount > 0) {
    return {
      main,
      note: `descontados ${formatEur(reward.appliedAmount)}; el resto, en su próxima factura`,
    };
  }
  return { main, note: 'en su próxima factura' };
}

export default function ReferralsPage() {
  const referrals = useReferrals();
  const stats = useReferralStats();
  const canManageSettings = useHasPermission('settings:manage');

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Referidos</h1>
        <p className="text-sm text-muted-foreground">
          Tus inquilinos recomiendan y, cuando el recomendado paga su primera factura, el que
          recomienda recibe un descuento en su siguiente factura. También puedes premiar al
          recomendado con un descuento en su primer pago.
        </p>
      </div>

      {stats.isError ? (
        <SectionError onRetry={() => void stats.refetch()} />
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <StatCard title="Referidos" value={stats.data?.total ?? null} loading={stats.isLoading} />
          <StatCard
            title="Pendientes"
            value={stats.data?.pending ?? null}
            loading={stats.isLoading}
          />
          <StatCard
            title="Ya son clientes"
            value={stats.data?.converted ?? null}
            loading={stats.isLoading}
          />
        </div>
      )}

      {canManageSettings && <ReferralSettingsCard />}

      <TopReferrersCard />

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Historial</h2>
        {referrals.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : referrals.isError ? (
          <SectionError onRetry={() => void referrals.refetch()} />
        ) : (referrals.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay referidos.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Quién recomienda</th>
                  <th className="px-3 py-2">Recomendado</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Recompensa</th>
                  <th className="px-3 py-2">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {(referrals.data ?? []).map((r) => {
                  const s = STATUS[r.status];
                  const reward = rewardText(r);
                  return (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-medium">{r.referrerName}</td>
                      <td className="px-3 py-2">{r.referredName}</td>
                      <td className="px-3 py-2">
                        <Badge variant={s.variant}>{s.label}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {reward ? (
                          <>
                            {reward.main}{' '}
                            <span className="text-muted-foreground">· {reward.note}</span>
                          </>
                        ) : (
                          <span className="font-mono">{r.rewardCode ?? '—'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{formatDate(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  title,
  value,
  loading,
}: {
  title: string;
  value: number | null;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="text-2xl font-semibold">{value ?? '—'}</div>
        )}
      </CardContent>
    </Card>
  );
}

type RewardKind = 'percentage' | 'fixed';

function ReferralSettingsCard() {
  const settings = useReferralSettings();
  const update = useUpdateReferralSettings();
  const [enabled, setEnabled] = useState(false);
  const [type, setType] = useState<RewardKind>('fixed');
  const [value, setValue] = useState('0');
  const [friendOn, setFriendOn] = useState(false);
  const [friendType, setFriendType] = useState<RewardKind>('percentage');
  const [friendValue, setFriendValue] = useState('10');
  const [capOn, setCapOn] = useState(false);
  const [cap, setCap] = useState('5');

  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setEnabled(d.referralEnabled);
    setType(d.referralRewardType === 'percentage' ? 'percentage' : 'fixed');
    setValue(String(d.referralRewardValue));
    setFriendOn(!!d.referralFriendRewardType && d.referralFriendRewardValue > 0);
    if (d.referralFriendRewardType) setFriendType(d.referralFriendRewardType);
    if (d.referralFriendRewardValue > 0) setFriendValue(String(d.referralFriendRewardValue));
    setCapOn(d.referralMaxRewardsPerYear != null);
    if (d.referralMaxRewardsPerYear != null) setCap(String(d.referralMaxRewardsPerYear));
  }, [settings.data]);

  async function save(nextEnabled = enabled) {
    try {
      await update.mutateAsync({
        referralEnabled: nextEnabled,
        referralRewardType: type,
        referralRewardValue: Number(value) || 0,
        referralFriendRewardType: friendOn ? friendType : null,
        referralFriendRewardValue: friendOn ? Number(friendValue) || 0 : 0,
        referralMaxRewardsPerYear: capOn ? Math.min(100, Math.max(1, Number(cap) || 1)) : null,
      });
      toast.success('Ajustes guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Programa de referidos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2">
          <Checkbox
            id="ref-enabled"
            checked={enabled}
            disabled={settings.isLoading || update.isPending}
            onCheckedChange={(v) => {
              setEnabled(v === true);
              void save(v === true);
            }}
          />
          <div className="space-y-0.5">
            <Label htmlFor="ref-enabled">Activar el programa de referidos</Label>
            <p className="text-xs text-muted-foreground">
              Cada inquilino obtiene un código y un enlace para compartir. Cuando el recomendado
              paga su primera factura, al que recomienda se le descuenta la recompensa de su
              siguiente factura.
            </p>
          </div>
        </div>
        {enabled && (
          <>
            <div className="space-y-1.5">
              <Label className="text-sm">Para quien recomienda</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={type} onValueChange={(v) => setType(v as RewardKind)}>
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Importe fijo (€)</SelectItem>
                    <SelectItem value="percentage">Porcentaje de su cuota (%)</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  max={type === 'percentage' ? 100 : undefined}
                  step="0.01"
                  className="w-28"
                  aria-label="Recompensa de quien recomienda"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Se descuenta de su siguiente factura. Un importe fijo mayor que su cuota se reparte
                entre las siguientes.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={friendOn} onCheckedChange={(v) => setFriendOn(v === true)} />
                Premiar también al recomendado
              </label>
              {friendOn && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={friendType}
                      onValueChange={(v) => setFriendType(v as RewardKind)}
                    >
                      <SelectTrigger className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Porcentaje (%)</SelectItem>
                        <SelectItem value="fixed">Importe fijo (€)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      max={friendType === 'percentage' ? 100 : undefined}
                      step="0.01"
                      className="w-28"
                      aria-label="Recompensa del recomendado"
                      value={friendValue}
                      onChange={(e) => setFriendValue(e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Descuento en el primer pago de quien reserva en tu web con el código o el enlace
                    de un inquilino. Solo para clientes nuevos y no se suma a otro código.
                  </p>
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={capOn} onCheckedChange={(v) => setCapOn(v === true)} />
                Poner un tope de recompensas por inquilino al año
              </label>
              {capOn && (
                <Input
                  type="number"
                  min={1}
                  max={100}
                  className="w-28"
                  aria-label="Recompensas al año"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                />
              )}
            </div>

            <Button onClick={() => void save()} disabled={update.isPending}>
              {update.isPending ? 'Guardando...' : 'Guardar'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TopReferrersCard() {
  const top = useReferralTop();
  if (!top.data || top.data.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Quién recomienda más</CardTitle>
        <CardDescription>Tus inquilinos que más clientes te han traído.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {top.data.map((t) => (
            <li
              key={t.customerId}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <Link href={`/customers/${t.customerId}`} className="font-medium hover:underline">
                {t.customerName}
              </Link>
              <span className="text-muted-foreground">
                {t.converted} {t.converted === 1 ? 'cliente' : 'clientes'} de {t.referred}{' '}
                {t.referred === 1 ? 'recomendado' : 'recomendados'}
                {t.rewardsFixedTotal > 0
                  ? ` · ${formatEur(t.rewardsFixedTotal)} en recompensas`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
