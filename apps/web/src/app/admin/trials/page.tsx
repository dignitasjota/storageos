'use client';

import {
  TRIAL_MESSAGE_TEMPLATES,
  type AdminExpiredTrialDto,
  type AdminTrialFilter,
  type AdminTrialRowDto,
} from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, Mail, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminBroadcast,
  useAdminSubscriptionPlans,
  useAdminSuperAdmins,
  useChangePlan,
  useEndTrial,
  useExtendTrial,
  useExtendTrialsBatch,
} from '@/lib/admin/hooks';
import { useExpiredTrials, useTrialsPage } from '@/lib/admin/tenant-ops-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatShortDay, plural } from '@/lib/format';

const FILTERS: { value: AdminTrialFilter; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'this_week', label: 'Vencen esta semana' },
  { value: 'expired', label: 'Vencidas' },
  { value: 'unused', label: 'Sin usar' },
  { value: 'real_use', label: 'Con uso real' },
];

const CONVERSION: Record<string, { label: string; className: string }> = {
  high: {
    label: 'Alta',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  },
  medium: {
    label: 'Media',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  low: { label: 'Baja', className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
};

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

/**
 * «Vencida», «Vence hoy», «Vence mañana» o «En 5 d» (días naturales en hora de
 * España, como los da el API).
 */
function endsLabel(t: { daysLeft: number | null; expired: boolean }): {
  label: string;
  className: string;
} {
  if (t.daysLeft === null) return { label: '—', className: '' };
  if (t.expired) {
    return {
      label: t.daysLeft < 0 ? `Vencida hace ${plural(-t.daysLeft, 'día', 'días')}` : 'Vencida hoy',
      className: 'text-red-600 dark:text-red-400',
    };
  }
  if (t.daysLeft <= 0) return { label: 'Vence hoy', className: 'text-red-600 dark:text-red-400' };
  return {
    label: t.daysLeft === 1 ? 'Vence mañana' : `En ${t.daysLeft} d`,
    className: t.daysLeft <= 3 ? 'text-amber-600 dark:text-amber-400' : '',
  };
}

export default function AdminTrialsPage() {
  const [view, setView] = useState<'current' | 'expired'>('current');
  const [writeTo, setWriteTo] = useState<{ ids: string[]; template: string } | null>(null);
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trials</h1>
        <p className="text-sm text-muted-foreground">
          Las pruebas en curso, lo que le falta a cada una para ponerse en marcha y las que
          terminaron sin pagar.
        </p>
      </div>
      <Tabs value={view} onValueChange={(v) => setView(v as 'current' | 'expired')}>
        <TabsList>
          <TabsTrigger value="current">En curso</TabsTrigger>
          <TabsTrigger value="expired">Caducadas sin pagar</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === 'current' ? (
        <CurrentTrials onWrite={(ids, template) => setWriteTo({ ids, template })} />
      ) : (
        <ExpiredTrials onWrite={(ids) => setWriteTo({ ids, template: 'free' })} />
      )}
      <WriteDialog target={writeTo} onClose={() => setWriteTo(null)} />
    </div>
  );
}

function CurrentTrials({ onWrite }: { onWrite: (ids: string[], template: string) => void }) {
  const canEdit = useIsSuperadmin();
  const ask = useConfirm();
  const admins = useAdminSuperAdmins();
  const reps = (admins.data ?? []).filter((a) => a.role === 'sales');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState({
    search: '',
    filter: 'all' as AdminTrialFilter,
    salesRepId: '',
    page: 1,
  });
  const trials = useTrialsPage(q);
  const batch = useExtendTrialsBatch();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (trials.isError) return <AdminError onRetry={() => void trials.refetch()} />;
  const data = trials.data;
  const rows = data?.items ?? [];
  const allChosen = rows.length > 0 && rows.every((t) => selected.has(t.id));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function extendBatch() {
    const res = await ask({
      title: `Ampliar ${selected.size} prueba(s)`,
      input: { label: 'Días', placeholder: '14' },
      confirmLabel: 'Ampliar',
    });
    if (!res) return;
    const days = Math.floor(Number(res.value || 14));
    if (!(days > 0 && days <= 365)) {
      toast.error('Indica entre 1 y 365 días.');
      return;
    }
    try {
      const r = await batch.mutateAsync({
        tenantIds: [...selected],
        days,
        reason: 'Extensión de prueba por lote',
      });
      if (r.skipped.length === 0) {
        toast.success(`Prueba ampliada en ${plural(r.updated, 'tenant', 'tenants')}.`);
      } else {
        toast.warning(
          `Prueba ampliada en ${plural(r.updated, 'tenant', 'tenants')}; ${plural(
            r.skipped.length,
            'no se ha ampliado',
            'no se han ampliado',
          )}.`,
          {
            description: r.skipped
              .slice(0, 5)
              .map((x) => `${x.name ?? x.tenantId}: ${x.reason}`)
              .join(' · '),
            duration: 10_000,
          },
        );
      }
      setSelected(new Set());
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo ampliar.'));
    }
  }

  const s = data?.summary;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi label="Pruebas en curso" value={s ? String(s.inProgress) : '—'} />
        <Kpi
          label="Conversión este mes"
          value={s?.conversionMonthPct != null ? `${s.conversionMonthPct} %` : '—'}
          hint={s ? `Pagan ${s.convertedThisMonth} de ${s.endedThisMonth} que terminan` : undefined}
        />
        <Kpi
          label="Días hasta pagar"
          value={s?.avgDaysToPay != null ? String(Math.round(s.avgDaysToPay)) : '—'}
          hint="Media de los últimos 3 meses"
        />
        <Kpi label="Ampliadas este mes" value={s ? String(s.extendedThisMonth) : '—'} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <form
          className="flex flex-1 gap-2 sm:min-w-[220px]"
          onSubmit={(e) => {
            e.preventDefault();
            setQ((x) => ({ ...x, search, page: 1 }));
          }}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, identificador o lead"
            aria-label="Buscar"
          />
          <Button type="submit" variant="outline" size="icon" aria-label="Buscar">
            <Search className="size-4" />
          </Button>
        </form>
        {reps.length > 0 ? (
          <Select
            value={q.salesRepId || 'all'}
            onValueChange={(v) =>
              setQ((x) => ({ ...x, salesRepId: v === 'all' ? '' : v, page: 1 }))
            }
          >
            <SelectTrigger className="sm:w-48" aria-label="Comercial">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los comerciales</SelectItem>
              {reps.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={q.filter === f.value}
            onClick={() => {
              setSelected(new Set());
              setQ((x) => ({ ...x, filter: f.value, page: 1 }));
            }}
            className={`h-8 rounded-md border px-3 text-sm ${
              q.filter === f.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {f.label} ({data?.counts[f.value] ?? 0})
          </button>
        ))}
      </div>

      {canEdit && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
          <span className="font-medium">{selected.size} seleccionada(s)</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void extendBatch()}
            disabled={batch.isPending}
          >
            Ampliar la prueba
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Mail className="mr-1.5 size-4" /> Escribir
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {TRIAL_MESSAGE_TEMPLATES.map((t) => (
                <DropdownMenuItem key={t.key} onSelect={() => onWrite([...selected], t.key)}>
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Limpiar
          </Button>
        </div>
      ) : null}

      {trials.isLoading || !data ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No hay pruebas con estos filtros.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {canEdit ? (
              <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allChosen}
                  onCheckedChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      rows.forEach((t) => (allChosen ? next.delete(t.id) : next.add(t.id)));
                      return next;
                    })
                  }
                  aria-label="Seleccionar la página"
                />
                Seleccionar la página
              </div>
            ) : null}
            <ul className="divide-y">
              {rows.map((t) => (
                <TrialRow
                  key={t.id}
                  trial={t}
                  selectable={canEdit}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onWrite={() => onWrite([t.id], 'help')}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {data && pages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {data.total} pruebas · página {data.page} de {pages}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={data.page <= 1}
              onClick={() => setQ((x) => ({ ...x, page: x.page - 1 }))}
            >
              <ChevronLeft className="size-4" /> Anterior
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.page >= pages}
              onClick={() => setQ((x) => ({ ...x, page: x.page + 1 }))}
            >
              Siguiente <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function TrialRow({
  trial,
  selectable,
  selected,
  onToggle,
  onWrite,
}: {
  trial: AdminTrialRowDto;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onWrite: () => void;
}) {
  const ends = endsLabel(trial);
  const conv = CONVERSION[trial.conversion.level]!;
  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={`Seleccionar ${trial.name}`}
            className="mt-1"
          />
        ) : null}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/admin/tenants/${trial.id}`} className="font-medium hover:underline">
              {trial.name}
            </Link>
            <span className="text-xs text-muted-foreground">{trial.planName ?? 'sin plan'}</span>
            <span className={`text-xs font-medium ${ends.className}`}>
              {ends.label}
              {trial.trialEndsAt ? ` · ${formatShortDay(trial.trialEndsAt)}` : ''}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {trial.neverUsed
              ? 'Nadie ha entrado nunca'
              : `Última actividad: ${formatShortDay(trial.lastActivityAt)}`}
            {trial.salesRepName ? ` · comercial: ${trial.salesRepName}` : ''}
            {trial.leadId ? (
              <>
                {' · '}
                <Link href={`/admin/leads?lead=${trial.leadId}`} className="hover:underline">
                  lead {trial.leadName ?? ''}
                </Link>
              </>
            ) : null}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs lg:w-[420px] lg:shrink-0">
        <div>
          <p className="font-medium">
            Progreso {trial.progress.done}/{trial.progress.total}
          </p>
          <div className="my-1 h-1.5 rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary"
              style={{ width: `${(trial.progress.done / trial.progress.total) * 100}%` }}
            />
          </div>
          <p className="text-muted-foreground">
            {trial.progress.missing.length
              ? `Falta: ${trial.progress.missing.join(', ')}`
              : 'Todo listo'}
          </p>
        </div>
        <div>
          <Badge className={`border-0 ${conv.className}`}>
            Probabilidad {conv.label.toLowerCase()}
          </Badge>
          <p className="mt-1 text-muted-foreground">{trial.conversion.reason}</p>
        </div>
      </div>
      <TrialActions trial={trial} onWrite={onWrite} />
    </li>
  );
}

function TrialActions({
  trial,
  onWrite,
}: {
  trial: { id: string; name: string; expired: boolean };
  onWrite: () => void;
}) {
  const extend = useExtendTrial();
  const endTrial = useEndTrial();
  const changePlan = useChangePlan();
  const plans = useAdminSubscriptionPlans();
  const ask = useConfirm();
  const canEdit = useIsSuperadmin();
  const qc = useQueryClient();

  async function onExtend() {
    const res = await ask({
      title: `Ampliar 14 días la prueba de ${trial.name}`,
      description: trial.expired
        ? 'La prueba ya venció: se amplía 14 días desde hoy.'
        : 'Se suman 14 días al fin de la prueba. Queda anotado en su historial.',
      input: { label: 'Motivo', placeholder: 'Necesita más tiempo para montarlo' },
      confirmLabel: 'Ampliar',
    });
    if (!res || !res.value.trim()) return;
    try {
      await extend.mutateAsync({ id: trial.id, input: { days: 14, reason: res.value.trim() } });
      toast.success('Prueba ampliada 14 días.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo ampliar.'));
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
      void qc.invalidateQueries({ queryKey: ['admin', 'trials'] });
      toast.success(`Ahora está en el plan ${name}.`);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el plan.'));
    }
  }

  async function onEnd() {
    const res = await ask({
      title: `Finalizar la prueba de ${trial.name}`,
      description: 'Conserva su plan, pero queda en solo lectura hasta que pague.',
      input: { label: 'Motivo', placeholder: 'No ha convertido' },
      confirmLabel: 'Finalizar prueba',
    });
    if (!res || !res.value.trim()) return;
    try {
      await endTrial.mutateAsync({ id: trial.id, input: { reason: res.value.trim() } });
      toast.success('Prueba finalizada.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo finalizar.'));
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {canEdit ? (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onExtend()}
            disabled={extend.isPending}
          >
            +14 días
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                Más
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onWrite}>Escribirle</DropdownMenuItem>
              <DropdownMenuSeparator />
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
                Finalizar prueba (solo lectura)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
      <Button asChild size="icon" variant="ghost" aria-label="Ver tenant" title="Ver tenant">
        <Link href={`/admin/tenants/${trial.id}`}>
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    </div>
  );
}

function ExpiredTrials({ onWrite }: { onWrite: (ids: string[]) => void }) {
  const list = useExpiredTrials(true);
  const canEdit = useIsSuperadmin();
  if (list.isError) return <AdminError onRetry={() => void list.refetch()} />;
  if (list.isLoading || !list.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (list.data.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Ninguna prueba ha terminado sin pagar.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Siguen activas en solo lectura hasta que paguen. {list.data.length} en total.
        </p>
        <ul className="divide-y">
          {list.data.map((t) => (
            <ExpiredRow key={t.id} t={t} canEdit={canEdit} onWrite={() => onWrite([t.id])} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ExpiredRow({
  t,
  canEdit,
  onWrite,
}: {
  t: AdminExpiredTrialDto;
  canEdit: boolean;
  onWrite: () => void;
}) {
  const ask = useConfirm();
  const extend = useExtendTrial();
  const changePlan = useChangePlan();
  const plans = useAdminSubscriptionPlans();
  const qc = useQueryClient();

  async function reopen() {
    const res = await ask({
      title: `Reabrir la prueba de ${t.name}`,
      description: 'Vuelve a estar en prueba con su plan durante los días que elijas.',
      input: { label: 'Motivo', placeholder: 'Quiere probarlo con su socio' },
      confirmLabel: 'Reabrir 14 días',
    });
    if (!res || !res.value.trim()) return;
    try {
      await extend.mutateAsync({ id: t.id, input: { days: 14, reason: res.value.trim() } });
      void qc.invalidateQueries({ queryKey: ['admin', 'trials'] });
      toast.success('Prueba reabierta 14 días.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo reabrir.'));
    }
  }

  async function onPlan(slug: string, name: string) {
    const res = await ask({
      title: `Pasar ${t.name} al plan ${name}`,
      input: { label: 'Motivo', placeholder: 'Ha aceptado el presupuesto' },
      confirmLabel: 'Cambiar plan',
    });
    if (!res || !res.value.trim()) return;
    try {
      await changePlan.mutateAsync({
        id: t.id,
        input: { planSlug: slug, reason: res.value.trim() },
      });
      void qc.invalidateQueries({ queryKey: ['admin', 'trials'] });
      toast.success(`Ahora está en el plan ${name}.`);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el plan.'));
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Link href={`/admin/tenants/${t.id}`} className="font-medium hover:underline">
          {t.name}
        </Link>
        <p className="text-xs text-muted-foreground">
          {t.planName ?? 'sin plan'} · terminó {formatShortDay(t.endedAt)}
          {t.daysSince !== null ? ` (hace ${t.daysSince} días)` : ''} · {t.facilities} loc. ·{' '}
          {t.units} trast. · {t.activeContracts} contr.
          {t.lastActivityAt
            ? ` · última actividad ${formatShortDay(t.lastActivityAt)}`
            : ' · nunca entró'}
          {t.salesRepName ? ` · comercial: ${t.salesRepName}` : ''}
          {t.leadId ? (
            <>
              {' · '}
              <Link href={`/admin/leads?lead=${t.leadId}`} className="hover:underline">
                ver lead
              </Link>
            </>
          ) : null}
        </p>
      </div>
      {canEdit ? (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void reopen()}
            disabled={extend.isPending}
          >
            Reabrir prueba
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                Pasar a un plan
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(plans.data ?? [])
                .filter((p) => p.isActive && p.slug !== 'free')
                .map((p) => (
                  <DropdownMenuItem key={p.slug} onSelect={() => void onPlan(p.slug, p.name)}>
                    {p.name}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={onWrite}>
            <Mail className="mr-1.5 size-4" /> Escribir
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Escribir a una o varias pruebas (anuncio a esos tenants, queda en Anuncios). */
function WriteDialog({
  target,
  onClose,
}: {
  target: { ids: string[]; template: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {target ? (
          <WriteForm
            key={`${target.template}:${target.ids.join(',')}`}
            target={target}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function WriteForm({
  target,
  onClose,
}: {
  target: { ids: string[]; template: string };
  onClose: () => void;
}) {
  const broadcast = useAdminBroadcast();
  const initial =
    TRIAL_MESSAGE_TEMPLATES.find((t) => t.key === target.template) ?? TRIAL_MESSAGE_TEMPLATES[0];
  const [template, setTemplate] = useState<string>(initial.key);
  const [subject, setSubject] = useState<string>(initial.subject);
  const [body, setBody] = useState<string>(initial.body);

  function pick(key: string) {
    const t = TRIAL_MESSAGE_TEMPLATES.find((x) => x.key === key);
    setTemplate(key);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  }

  async function send() {
    try {
      const res = await broadcast.mutateAsync({
        audience: 'all',
        tenantIds: target.ids,
        subject: subject.trim(),
        body: body.trim(),
        commercial: false,
      });
      toast.success(
        `Enviado a ${res.tenants} (${res.recipients} correos)${res.skipped ? ` · ${res.skipped} sin destinatario` : ''}.`,
      );
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo enviar.'));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Escribir a {target.ids.length === 1 ? '1 prueba' : `${target.ids.length} pruebas`}
        </DialogTitle>
        <DialogDescription>
          Llega a los propietarios de cada uno y queda en sus mensajes. {'{empresa}'} y {'{nombre}'}{' '}
          se cambian por los suyos.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Select value={template} onValueChange={pick}>
          <SelectTrigger aria-label="Plantilla">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRIAL_MESSAGE_TEMPLATES.map((t) => (
              <SelectItem key={t.key} value={t.key}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="space-y-1">
          <Label htmlFor="tw-subject">Asunto</Label>
          <Input
            id="tw-subject"
            value={subject}
            maxLength={200}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tw-body">Mensaje</Label>
          <Textarea id="tw-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          onClick={() => void send()}
          disabled={subject.trim().length < 3 || !body.trim() || broadcast.isPending}
        >
          {broadcast.isPending ? 'Enviando…' : 'Enviar'}
        </Button>
      </DialogFooter>
    </>
  );
}
