'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ReferralDto } from '@storageos/shared';

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
  pending: { label: 'Pendiente', variant: 'secondary' },
  converted: { label: 'Convertido', variant: 'default' },
  cancelled: { label: 'Cancelado', variant: 'outline' },
};

export default function ReferralsPage() {
  const referrals = useReferrals();
  const stats = useReferralStats();
  const canManageSettings = useHasPermission('settings:manage');

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Referidos</h1>
        <p className="text-sm text-muted-foreground">
          Tus inquilinos recomiendan y, al firmar el referido, el referidor recibe una recompensa.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard title="Referidos" value={stats.data?.total ?? null} loading={stats.isLoading} />
        <StatCard
          title="Pendientes"
          value={stats.data?.pending ?? null}
          loading={stats.isLoading}
        />
        <StatCard
          title="Convertidos"
          value={stats.data?.converted ?? null}
          loading={stats.isLoading}
        />
      </div>

      {canManageSettings && <ReferralSettingsCard />}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Historial</h2>
        {referrals.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (referrals.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay referidos.</p>
        ) : (
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Referidor</th>
                  <th className="px-3 py-2">Referido</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Recompensa</th>
                  <th className="px-3 py-2">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {(referrals.data ?? []).map((r) => {
                  const s = STATUS[r.status];
                  return (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-medium">{r.referrerName}</td>
                      <td className="px-3 py-2">{r.referredName}</td>
                      <td className="px-3 py-2">
                        <Badge variant={s.variant}>{s.label}</Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.rewardCode ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {new Date(r.createdAt).toLocaleDateString('es-ES')}
                      </td>
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
              Cada inquilino obtiene un código. Al firmar el referido, el referidor recibe una
              promoción de un solo uso con la recompensa indicada.
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
