'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminTrialDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  useAdminSubscriptionPlans,
  useAdminTrials,
  useChangePlan,
  useEndTrial,
  useExtendTrial,
  useExtendTrialsBatch,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : '—');

export default function AdminTrialsPage() {
  const trials = useAdminTrials();
  const batch = useExtendTrialsBatch();
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDays, setBatchDays] = useState(14);

  if (trials.isError) {
    return <AdminError onRetry={() => void trials.refetch()} />;
  }
  if (trials.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const all = trials.data ?? [];
  const rows = onlyUnused ? all.filter((t) => t.neverUsed) : all;
  const unusedCount = all.filter((t) => t.neverUsed).length;
  const visibleIds = rows.map((t) => t.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function onExtendBatch() {
    const tenantIds = [...selected];
    if (tenantIds.length === 0) return;
    if (!(batchDays > 0)) {
      toast.error('Indica un número de días positivo.');
      return;
    }
    try {
      const res = await batch.mutateAsync({
        tenantIds,
        days: batchDays,
        reason: 'Extensión de trial por lote',
      });
      toast.success(`Trial extendido en ${res.updated} tenant(s).`);
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo extender.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trials</h1>
          <p className="text-sm text-muted-foreground">
            {all.length} en prueba · {unusedCount} nunca han usado la plataforma. Ordenados por
            expiración.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyUnused}
            onChange={(e) => setOnlyUnused(e.target.checked)}
          />
          Solo los que nunca han accedido
        </label>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-3 text-sm">
          <span className="font-medium">{selected.size} seleccionado(s)</span>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Extender</span>
            <Input
              type="number"
              min={1}
              max={365}
              value={batchDays}
              onChange={(e) => setBatchDays(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="h-8 w-20"
            />
            <span className="text-muted-foreground">días</span>
          </div>
          <Button size="sm" onClick={onExtendBatch} disabled={batch.isPending}>
            {batch.isPending ? 'Extendiendo…' : `Extender trial ${batchDays} días`}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Limpiar selección
          </Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {onlyUnused ? 'No hay trials sin usar.' : 'No hay trials activos.'}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Seleccionar todos"
                  />
                </th>
                <th className="p-2">Tenant</th>
                <th className="p-2">Plan</th>
                <th className="p-2">Fin trial</th>
                <th className="p-2">Vence en</th>
                <th className="p-2">Última actividad</th>
                <th className="p-2">Uso</th>
                <th className="p-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <TrialRow
                  key={t.id}
                  trial={t}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrialRow({
  trial,
  selected,
  onToggle,
}: {
  trial: AdminTrialDto;
  selected: boolean;
  onToggle: () => void;
}) {
  const extend = useExtendTrial();
  const endTrial = useEndTrial();
  const changePlan = useChangePlan();
  const plans = useAdminSubscriptionPlans();
  const ask = useConfirm();
  const canEdit = useIsSuperadmin();

  async function onEnd() {
    const res = await ask({
      title: `Finalizar la prueba de ${trial.name}`,
      description: 'Baja al plan Free (gratis, sin funciones de pago) y queda activo.',
      input: { label: 'Motivo', placeholder: 'No ha convertido' },
      confirmLabel: 'Finalizar prueba',
    });
    if (!res || !res.value.trim()) return;
    try {
      await endTrial.mutateAsync({ id: trial.id, input: { reason: res.value.trim() } });
      toast.success('Prueba finalizada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo finalizar.');
    }
  }

  async function onPlan(slug: string, name: string) {
    const res = await ask({
      title: `Pasar ${trial.name} al plan ${name}`,
      description: 'Termina la prueba y queda activo en ese plan.',
      input: { label: 'Motivo', placeholder: 'Ha aceptado el presupuesto' },
      confirmLabel: 'Cambiar plan',
    });
    if (!res || !res.value.trim()) return;
    try {
      await changePlan.mutateAsync({
        id: trial.id,
        input: { planSlug: slug, reason: res.value.trim() },
      });
      toast.success(`Ahora está en el plan ${name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar el plan.');
    }
  }

  async function onExtend() {
    try {
      await extend.mutateAsync({
        id: trial.id,
        input: { days: 14, reason: 'Extensión desde la gestión de trials' },
      });
      toast.success('Trial extendido 14 días.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo extender.');
    }
  }

  const overdue = trial.daysLeft !== null && trial.daysLeft < 0;
  const soon = trial.daysLeft !== null && trial.daysLeft >= 0 && trial.daysLeft <= 3;

  return (
    <tr className="border-t">
      <td className="p-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Seleccionar ${trial.name}`}
        />
      </td>
      <td className="p-2">
        <Link href={`/admin/tenants/${trial.id}`} className="font-medium hover:underline">
          {trial.name}
        </Link>
        <span className="block text-xs text-muted-foreground">/{trial.slug}</span>
      </td>
      <td className="p-2">{trial.planName ?? '—'}</td>
      <td className="p-2 whitespace-nowrap">{fmtDate(trial.trialEndsAt)}</td>
      <td className="p-2 whitespace-nowrap">
        {trial.daysLeft === null ? (
          '—'
        ) : (
          <span
            className={
              overdue
                ? 'text-red-600 dark:text-red-400'
                : soon
                  ? 'text-amber-600 dark:text-amber-400'
                  : ''
            }
          >
            {overdue ? `vencido hace ${Math.abs(trial.daysLeft)} d` : `${trial.daysLeft} d`}
          </span>
        )}
      </td>
      <td className="p-2 whitespace-nowrap">
        {trial.neverUsed ? (
          <span className="text-muted-foreground">Nunca accedió</span>
        ) : (
          fmtDate(trial.lastActivityAt)
        )}
      </td>
      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
        {trial.facilities} loc. · {trial.units} trast. · {trial.activeContracts} contr.
      </td>
      <td className="p-2">
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={onExtend}
            disabled={extend.isPending}
          >
            +14 días
          </Button>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 text-xs">
                  Más
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Pasar a un plan</DropdownMenuLabel>
                {(plans.data ?? [])
                  .filter((p) => p.isActive && p.slug !== 'free')
                  .map((p) => (
                    <DropdownMenuItem key={p.slug} onSelect={() => void onPlan(p.slug, p.name)}>
                      {p.name}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => void onEnd()}
                >
                  Finalizar prueba (a Free)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            asChild
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="Ver tenant"
            title="Ver tenant"
          >
            <Link href={`/admin/tenants/${trial.id}`}>
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </td>
    </tr>
  );
}
