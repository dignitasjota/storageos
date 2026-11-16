'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ReferralDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  if (!reward) return null;
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
          recomienda recibe un descuento en su siguiente factura.
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

function ReferralSettingsCard() {
  const settings = useReferralSettings();
  const update = useUpdateReferralSettings();
  const [type, setType] = useState<'percentage' | 'fixed' | null>(null);
  const [value, setValue] = useState<number | null>(null);

  const enabled = settings.data?.referralEnabled ?? false;
  const rewardType = (type ?? settings.data?.referralRewardType ?? 'fixed') as
    | 'percentage'
    | 'fixed';
  const rewardValue = value ?? settings.data?.referralRewardValue ?? 0;

  async function save(next: {
    referralEnabled: boolean;
    referralRewardType: 'percentage' | 'fixed';
    referralRewardValue: number;
  }) {
    try {
      await update.mutateAsync(next);
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
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2">
          <Checkbox
            id="ref-enabled"
            checked={enabled}
            disabled={settings.isLoading || update.isPending}
            onCheckedChange={(v) =>
              save({
                referralEnabled: v === true,
                referralRewardType: rewardType,
                referralRewardValue: rewardValue,
              })
            }
          />
          <div className="space-y-0.5">
            <Label htmlFor="ref-enabled">Activar el programa de referidos</Label>
            <p className="text-xs text-muted-foreground">
              Cada inquilino obtiene un código. Cuando el recomendado paga su primera factura, al
              que recomienda se le descuenta la recompensa de su siguiente factura: un porcentaje de
              su cuota o un importe fijo (si es mayor que la cuota, el resto pasa a las siguientes).
            </p>
          </div>
        </div>
        {enabled && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-sm">Recompensa</Label>
              <Select
                value={rewardType}
                onValueChange={(v) => setType(v as 'percentage' | 'fixed')}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Importe fijo (€)</SelectItem>
                  <SelectItem value="percentage">Porcentaje (%)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input
              type="number"
              min={0}
              max={rewardType === 'percentage' ? 100 : undefined}
              step="0.01"
              className="w-28"
              value={rewardValue}
              onChange={(e) => setValue(Number(e.target.value))}
            />
            <button
              type="button"
              className="text-sm font-medium text-primary hover:underline"
              onClick={() =>
                save({
                  referralEnabled: true,
                  referralRewardType: rewardType,
                  referralRewardValue: rewardValue,
                })
              }
            >
              Guardar recompensa
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
