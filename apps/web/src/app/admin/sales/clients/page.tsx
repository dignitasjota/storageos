'use client';

import {
  SALES_CLIENT_FILTER_LABELS,
  SALES_CLIENT_FILTERS,
  SALES_CLIENT_SORT_DEFAULT_DIR,
  SALES_CLIENT_SORT_LABELS,
  SALES_CLIENT_SORTS,
  SALES_TEMPERATURE_LABELS,
  type AdminSavedViewDto,
  type SalesClientFilter,
  type SalesClientRowDto,
  type SalesClientSort,
  type SalesLeadTemperatureFilter,
} from '@storageos/shared';
import { ArrowDown, ArrowUp, Loader2, Search, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  Empty,
  PageHeader,
  ProfileGlance,
  QueryError,
  relativeDays,
  SalesPage,
  Stat,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { SavedViewsMenu } from '@/components/admin/sales/portfolio';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSalesClients } from '@/lib/admin/sales-hooks';
import { formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = 'all';

const HEALTH_CLASS: Record<string, string> = {
  healthy: 'text-emerald-700 dark:text-emerald-400',
  warm: 'text-amber-700 dark:text-amber-400',
  at_risk: 'text-rose-700 dark:text-rose-400',
  dormant: 'text-rose-700 dark:text-rose-400',
};

interface ClientListState {
  search: string;
  filter: SalesClientFilter | null;
  temperature: SalesLeadTemperatureFilter | null;
  batch: string | null;
  sort: SalesClientSort;
  dir: 'asc' | 'desc';
}

const EMPTY: ClientListState = {
  search: '',
  filter: null,
  temperature: null,
  batch: null,
  sort: 'name',
  dir: 'asc',
};

function fromView(v: AdminSavedViewDto): ClientListState {
  const f = v.filters as Partial<Record<keyof ClientListState, string>>;
  const sort = SALES_CLIENT_SORTS.includes(v.sort?.key as SalesClientSort)
    ? (v.sort!.key as SalesClientSort)
    : 'name';
  return {
    search: typeof f.search === 'string' ? f.search : '',
    filter: SALES_CLIENT_FILTERS.includes(f.filter as SalesClientFilter)
      ? (f.filter as SalesClientFilter)
      : null,
    temperature: (['cold', 'warm', 'hot', 'none'] as const).includes(
      f.temperature as SalesLeadTemperatureFilter,
    )
      ? (f.temperature as SalesLeadTemperatureFilter)
      : null,
    batch: typeof f.batch === 'string' ? f.batch : null,
    sort,
    dir: v.sort ? (v.sort.dir === 1 ? 'asc' : 'desc') : SALES_CLIENT_SORT_DEFAULT_DIR[sort],
  };
}

function TrialLeft({ c }: { c: SalesClientRowDto }) {
  if (c.trialDaysLeft === null) return null;
  return (
    <span
      className={cn(
        'text-xs',
        c.trialDaysLeft <= 3 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground',
      )}
    >
      {c.trialDaysLeft >= 0 ? `Le quedan ${c.trialDaysLeft} días` : 'Prueba acabada'}
    </span>
  );
}

function Opportunities({ c }: { c: SalesClientRowDto }) {
  if (c.opportunities.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-violet-700 dark:text-violet-300">
      <Sparkles className="size-3" />
      Ofrécele {c.opportunities.slice(0, 2).join(', ')}
      {c.opportunities.length > 2 && ` y ${c.opportunities.length - 2} más`}
    </span>
  );
}

export default function SalesClientsPage() {
  const [state, setState] = useState<ClientListState>(EMPTY);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(state.search.trim()), 300);
    return () => clearTimeout(t);
  }, [state.search]);
  const clients = useSalesClients({
    ...(search.length >= 2 ? { search } : {}),
    ...(state.filter ? { filter: state.filter } : {}),
    ...(state.temperature ? { temperature: state.temperature } : {}),
    ...(state.batch ? { batch: state.batch } : {}),
    sort: state.sort,
    dir: state.dir,
    opportunities: true,
  });
  const all = useSalesClients();
  const rows = clients.data ?? [];
  const base = all.data ?? [];
  const mrr = base
    .filter((c) => c.firstPaidAt && c.status === 'active')
    .reduce((s, c) => s + c.monthly, 0);
  const batches = [...new Set(base.map((c) => c.batch).filter((b): b is string => !!b))].sort(
    (a, b) => a.localeCompare(b, 'es'),
  );
  const set = (patch: Partial<ClientListState>) => setState((s) => ({ ...s, ...patch }));
  const onSort = (key: SalesClientSort) =>
    set({
      sort: key,
      dir:
        state.sort === key
          ? state.dir === 'asc'
            ? 'desc'
            : 'asc'
          : SALES_CLIENT_SORT_DEFAULT_DIR[key],
    });
  const filtersOn = !!state.search || !!state.filter || !!state.temperature || !!state.batch;

  return (
    <SalesPage>
      <PageHeader
        title="Clientes"
        description="Las cuentas que son tuyas: sus pruebas, lo que pagan y cómo las usan."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cuentas" value={base.length} />
        <Stat label="En prueba" value={base.filter((c) => c.status === 'trial').length} />
        <Stat
          label="Pagando"
          value={base.filter((c) => c.firstPaidAt && c.status === 'active').length}
        />
        <Stat label="Pagan al mes" value={formatEur(mrr)} tone="good" />
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <button
          type="button"
          onClick={() => set({ filter: null })}
          className={cn(
            'shrink-0 rounded-full border px-3 py-1 text-xs',
            !state.filter ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          Todos
        </button>
        {SALES_CLIENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => set({ filter: f })}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs',
              state.filter === f
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground',
            )}
          >
            {SALES_CLIENT_FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar por nombre, plan o nota"
              value={state.search}
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>
          <SavedViewsMenu
            page="sales_clients"
            current={{
              filters: Object.fromEntries(
                Object.entries({
                  search: state.search,
                  filter: state.filter,
                  temperature: state.temperature,
                  batch: state.batch,
                }).filter(([, v]) => !!v),
              ),
              sort: { key: state.sort, dir: state.dir === 'asc' ? 1 : -1 },
            }}
            onApply={(v) => setState(fromView(v))}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Select
            value={state.temperature ?? ALL}
            onValueChange={(v) =>
              set({ temperature: v === ALL ? null : (v as SalesLeadTemperatureFilter) })
            }
          >
            <SelectTrigger className="sm:w-[180px]" aria-label="Temperatura">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Cualquier temperatura</SelectItem>
              <SelectItem value="hot">{SALES_TEMPERATURE_LABELS.hot}</SelectItem>
              <SelectItem value="warm">{SALES_TEMPERATURE_LABELS.warm}</SelectItem>
              <SelectItem value="cold">{SALES_TEMPERATURE_LABELS.cold}</SelectItem>
              <SelectItem value="none">Sin marcar</SelectItem>
            </SelectContent>
          </Select>
          {(batches.length > 0 || state.batch) && (
            <Select
              value={state.batch ?? ALL}
              onValueChange={(v) => set({ batch: v === ALL ? null : v })}
            >
              <SelectTrigger className="sm:w-[180px]" aria-label="Lote">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los lotes</SelectItem>
                {state.batch && !batches.includes(state.batch) && (
                  <SelectItem value={state.batch}>{state.batch}</SelectItem>
                )}
                {batches.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <Select value={state.sort} onValueChange={(v) => onSort(v as SalesClientSort)}>
              <SelectTrigger className="flex-1 sm:w-[200px]" aria-label="Ordenar por">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SALES_CLIENT_SORTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    Ordenar: {SALES_CLIENT_SORT_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              aria-label={state.dir === 'asc' ? 'De menos a más' : 'De más a menos'}
              title={state.dir === 'asc' ? 'De menos a más' : 'De más a menos'}
              onClick={() => set({ dir: state.dir === 'asc' ? 'desc' : 'asc' })}
            >
              {state.dir === 'asc' ? (
                <ArrowUp className="size-4" />
              ) : (
                <ArrowDown className="size-4" />
              )}
            </Button>
          </div>
          {filtersOn && (
            <Button
              variant="ghost"
              size="sm"
              className="col-span-2 h-9 justify-start sm:col-span-1"
              onClick={() => setState({ ...EMPTY, sort: state.sort, dir: state.dir })}
            >
              <X className="mr-1 size-4" />
              Quitar filtros
            </Button>
          )}
        </div>
      </div>

      {clients.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : clients.isError ? (
        <QueryError query={clients} />
      ) : rows.length === 0 ? (
        <Empty>No hay clientes con estos filtros.</Empty>
      ) : (
        <>
          {/* Móvil: tarjetas. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((c) => (
              <li key={c.tenantId} className="rounded-lg border bg-card p-3 text-sm shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/admin/sales/accounts/${c.leadId}`}
                    className="min-w-0 break-words font-medium hover:underline"
                  >
                    {c.name}
                  </Link>
                  <span className="shrink-0 tabular-nums">{formatEur(c.monthly)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <TenantStatusBadge status={c.status} pastDue={c.pastDue} />
                  <TrialLeft c={c} />
                  {c.planName && <span>{c.planName}</span>}
                  <TemperatureBadge value={c.profile?.temperature} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.units} trasteros{c.unitsLimit !== null && ` de ${c.unitsLimit}`} ·{' '}
                  {c.contracts} contratos · Último acceso {relativeDays(c.lastLoginAt)}
                </p>
                <Opportunities c={c} />
                {c.nextFollowup && (
                  <p className="mt-1 text-xs">
                    → {c.nextFollowup.title}{' '}
                    <span className="text-muted-foreground">
                      ({relativeDays(c.nextFollowup.dueDate)})
                    </span>
                  </p>
                )}
                <ProfileGlance profile={c.profile} />
              </li>
            ))}
          </ul>

          <div className="hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => onSort('monthly')}
                    >
                      Al mes
                      {state.sort === 'monthly' &&
                        (state.dir === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        ))}
                    </button>
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">Uso</TableHead>
                  <TableHead className="hidden lg:table-cell">Último acceso</TableHead>
                  <TableHead>Siguiente paso</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.tenantId}>
                    <TableCell>
                      <Link
                        href={`/admin/sales/accounts/${c.leadId}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {c.planName && <span>{c.planName}</span>}
                        {c.addons.length > 0 && <span>· {c.addons.join(', ')}</span>}
                        <TemperatureBadge value={c.profile?.temperature} />
                      </div>
                      <Opportunities c={c} />
                      <ProfileGlance profile={c.profile} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <TenantStatusBadge status={c.status} pastDue={c.pastDue} />
                        <TrialLeft c={c} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatEur(c.monthly)}
                    </TableCell>
                    <TableCell className="hidden text-xs lg:table-cell">
                      {c.units} trasteros
                      {c.unitsLimit !== null && ` de ${c.unitsLimit}`} · {c.contracts} contratos
                      {c.healthScore !== null && (
                        <span className={cn('block', HEALTH_CLASS[c.healthLevel ?? ''] ?? '')}>
                          Salud {c.healthScore}/100
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {relativeDays(c.lastLoginAt)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.nextFollowup ? (
                        <>
                          {c.nextFollowup.title}
                          <span className="block text-muted-foreground">
                            {relativeDays(c.nextFollowup.dueDate)}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </SalesPage>
  );
}
