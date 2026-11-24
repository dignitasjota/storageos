'use client';

import {
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_STAGES,
  SALES_LEAD_FILTER_LABELS,
  SALES_LEAD_FILTERS,
  SALES_LEAD_SIZE_LABELS,
  SALES_LEAD_SIZES,
  SALES_LEAD_SORT_DEFAULT_DIR,
  SALES_LEAD_SORT_LABELS,
  SALES_LEAD_SORTS,
  SALES_TEMPERATURE_LABELS,
  type AdminSavedViewDto,
  type PlatformLeadStage,
  type SalesLeadFilter,
  type SalesLeadSize,
  type SalesLeadSort,
  type SalesLeadTemperatureFilter,
} from '@storageos/shared';
import { ArrowDown, ArrowUp, ChevronDown, Loader2, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { BulkDialog, type BulkKind } from './bulk-dialog';

import {
  Empty,
  ProfileGlance,
  QueryError,
  relativeDays,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import {
  LeadCard,
  LeadPriority,
  PhoneLink,
  SavedViewsMenu,
} from '@/components/admin/sales/portfolio';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useSalesLeads, type SalesLeadsParams } from '@/lib/admin/sales-hooks';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = 'all';

export interface LeadListState {
  search: string;
  status: PlatformLeadStage | null;
  filter: SalesLeadFilter | null;
  batch: string | null;
  city: string | null;
  size: SalesLeadSize | null;
  temperature: SalesLeadTemperatureFilter | null;
  sort: SalesLeadSort;
  dir: 'asc' | 'desc';
}

export const EMPTY_LIST_STATE: LeadListState = {
  search: '',
  status: null,
  filter: null,
  batch: null,
  city: null,
  size: null,
  temperature: null,
  sort: 'priority',
  dir: 'desc',
};

const TEMPERATURE_OPTIONS: { value: SalesLeadTemperatureFilter; label: string }[] = [
  { value: 'hot', label: SALES_TEMPERATURE_LABELS.hot },
  { value: 'warm', label: SALES_TEMPERATURE_LABELS.warm },
  { value: 'cold', label: SALES_TEMPERATURE_LABELS.cold },
  { value: 'none', label: 'Sin marcar' },
];

/** Los filtros que se guardan en una vista (sin el orden ni la búsqueda vacía). */
function viewFilters(s: LeadListState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['search', 'status', 'filter', 'batch', 'city', 'size', 'temperature'] as const) {
    const v = s[k];
    if (v) out[k] = v;
  }
  return out;
}

function fromView(v: AdminSavedViewDto): LeadListState {
  const f = v.filters as Partial<Record<keyof LeadListState, string>>;
  const sort = SALES_LEAD_SORTS.includes(v.sort?.key as SalesLeadSort)
    ? (v.sort!.key as SalesLeadSort)
    : 'priority';
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[]): T | null =>
    value && allowed.includes(value as T) ? (value as T) : null;
  return {
    search: typeof f.search === 'string' ? f.search : '',
    status: pick(f.status, PLATFORM_LEAD_STAGES),
    filter: pick(f.filter, SALES_LEAD_FILTERS),
    batch: typeof f.batch === 'string' ? f.batch : null,
    city: typeof f.city === 'string' ? f.city : null,
    size: pick(f.size, SALES_LEAD_SIZES),
    temperature: pick(f.temperature, ['cold', 'warm', 'hot', 'none'] as const),
    sort,
    dir: v.sort ? (v.sort.dir === 1 ? 'asc' : 'desc') : SALES_LEAD_SORT_DEFAULT_DIR[sort],
  };
}

/** Búsqueda con espera: no pide al servidor con cada letra. */
function useDebounced(value: string, ms = 300): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function toParams(s: LeadListState, search: string): SalesLeadsParams {
  return {
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    ...(s.status ? { status: s.status } : {}),
    ...(s.filter ? { filter: s.filter } : {}),
    ...(s.batch ? { batch: s.batch } : {}),
    ...(s.city ? { city: s.city } : {}),
    ...(s.size ? { size: s.size } : {}),
    ...(s.temperature ? { temperature: s.temperature } : {}),
    sort: s.sort,
    dir: s.dir,
  };
}

function SortHead({
  label,
  sortKey,
  state,
  onSort,
  className,
}: {
  label: string;
  sortKey: SalesLeadSort;
  state: LeadListState;
  onSort: (key: SalesLeadSort) => void;
  className?: string;
}) {
  const active = state.sort === sortKey;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          active && 'font-semibold text-foreground',
        )}
      >
        {label}
        {active &&
          (state.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );
}

/**
 * La lista de su cartera: por páginas, con orden y filtros en el servidor,
 * vistas guardadas y acciones en lote (tarjetas en el móvil).
 */
export function ListView({
  state,
  onChange,
}: {
  state: LeadListState;
  onChange: (s: LeadListState) => void;
}) {
  const search = useDebounced(state.search);
  const params = useMemo(() => toParams(state, search), [state, search]);
  const leads = useSalesLeads(params);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkKind | null>(null);

  const first = leads.data?.pages[0];
  const items = useMemo(() => leads.data?.pages.flatMap((p) => p.items) ?? [], [leads.data]);
  const counts = first?.counts ?? {};
  const batches = first?.batches ?? [];
  const cities = first?.cities ?? [];
  const newForYou = first?.newForYou ?? 0;
  const total = first?.total ?? 0;

  // Al cambiar de filtros, la selección se vacía (no se aplica a lo que no se ve).
  useEffect(() => setSelected(new Set()), [params]);

  const set = (patch: Partial<LeadListState>) => onChange({ ...state, ...patch });
  const onSort = (key: SalesLeadSort) =>
    set({
      sort: key,
      dir:
        state.sort === key
          ? state.dir === 'asc'
            ? 'desc'
            : 'asc'
          : SALES_LEAD_SORT_DEFAULT_DIR[key],
    });
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allLoaded = items.length > 0 && items.every((i) => selected.has(i.id));
  const filtersOn =
    !!state.search ||
    !!state.status ||
    !!state.filter ||
    !!state.batch ||
    !!state.city ||
    !!state.size ||
    !!state.temperature;

  return (
    <div className={cn('space-y-4', selected.size > 0 && 'pb-20 md:pb-0')}>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <button
          type="button"
          onClick={() => set({ status: null })}
          className={cn(
            'shrink-0 rounded-full border px-3 py-1 text-xs',
            !state.status ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          Todas las fases
        </button>
        {PLATFORM_LEAD_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => set({ status: s })}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs',
              state.status === s
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground',
            )}
          >
            {PLATFORM_LEAD_STAGE_LABELS[s]} {counts[s] ? `· ${counts[s]}` : ''}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar por empresa, persona, email, teléfono o ciudad"
              value={state.search}
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>
          <SavedViewsMenu
            page="sales_leads"
            current={{
              filters: viewFilters(state),
              sort: { key: state.sort, dir: state.dir === 'asc' ? 1 : -1 },
            }}
            onApply={(v) => onChange(fromView(v))}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Select
            value={state.filter ?? ALL}
            onValueChange={(v) => set({ filter: v === ALL ? null : (v as SalesLeadFilter) })}
          >
            <SelectTrigger className="sm:w-[210px]" aria-label="Filtro">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              {SALES_LEAD_FILTERS.map((f) => (
                <SelectItem key={f} value={f}>
                  {SALES_LEAD_FILTER_LABELS[f]}
                  {f === 'new_for_you' && newForYou > 0 ? ` · ${newForYou}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={state.temperature ?? ALL}
            onValueChange={(v) =>
              set({ temperature: v === ALL ? null : (v as SalesLeadTemperatureFilter) })
            }
          >
            <SelectTrigger className="sm:w-[160px]" aria-label="Temperatura">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Cualquier temperatura</SelectItem>
              {TEMPERATURE_OPTIONS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={state.size ?? ALL}
            onValueChange={(v) => set({ size: v === ALL ? null : (v as SalesLeadSize) })}
          >
            <SelectTrigger className="sm:w-[200px]" aria-label="Tamaño">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Cualquier tamaño</SelectItem>
              {SALES_LEAD_SIZES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SALES_LEAD_SIZE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(cities.length > 0 || state.city) && (
            <Select
              value={state.city ?? ALL}
              onValueChange={(v) => set({ city: v === ALL ? null : v })}
            >
              <SelectTrigger className="sm:w-[170px]" aria-label="Ciudad">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas las ciudades</SelectItem>
                {state.city && !cities.some((c) => c.name === state.city) && (
                  <SelectItem value={state.city}>{state.city}</SelectItem>
                )}
                {cities.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name} · {c.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {(batches.length > 0 || state.batch) && (
            <Select
              value={state.batch ?? ALL}
              onValueChange={(v) => set({ batch: v === ALL ? null : v })}
            >
              <SelectTrigger className="sm:w-[190px]" aria-label="Lote">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los lotes</SelectItem>
                {state.batch && !batches.some((b) => b.name === state.batch) && (
                  <SelectItem value={state.batch}>{state.batch}</SelectItem>
                )}
                {batches.map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {b.name} · {b.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <Select value={state.sort} onValueChange={(v) => onSort(v as SalesLeadSort)}>
              <SelectTrigger className="flex-1 sm:w-[190px]" aria-label="Ordenar por">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SALES_LEAD_SORTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    Ordenar: {SALES_LEAD_SORT_LABELS[s]}
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
              onClick={() => onChange({ ...EMPTY_LIST_STATE, sort: state.sort, dir: state.dir })}
            >
              <X className="mr-1 size-4" />
              Quitar filtros
            </Button>
          )}
        </div>
      </div>

      {newForYou > 0 && state.filter !== 'new_for_you' && (
        <button
          type="button"
          onClick={() => set({ filter: 'new_for_you' })}
          className="w-full rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-left text-sm text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
        >
          La dirección te ha pasado{' '}
          {newForYou === 1 ? 'un prospecto nuevo' : `${newForYou} prospectos nuevos`}. Verlos
        </button>
      )}

      {leads.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : leads.isError ? (
        <QueryError query={leads} />
      ) : items.length === 0 ? (
        <Empty>No hay prospectos con estos filtros.</Empty>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={allLoaded}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
                }
              />
              Seleccionar los {items.length} que ves
            </label>
            <span className="tabular-nums">
              {items.length} de {total}
            </span>
          </div>

          {/* Móvil: tarjetas. */}
          <div className="space-y-2 md:hidden">
            {items.map((l) => (
              <LeadCard
                key={l.id}
                lead={l}
                selected={selected.has(l.id)}
                onSelect={(on) => toggle(l.id, on)}
              />
            ))}
          </div>

          {/* Escritorio: tabla. */}
          <div className="hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Cuenta</TableHead>
                  <SortHead label="Prioridad" sortKey="priority" state={state} onSort={onSort} />
                  <TableHead>Fase</TableHead>
                  <SortHead
                    label="Último contacto"
                    sortKey="last_contact"
                    state={state}
                    onSort={onSort}
                  />
                  <TableHead className="hidden lg:table-cell">Siguiente paso</TableHead>
                  <SortHead
                    label="Asignado el"
                    sortKey="assigned"
                    state={state}
                    onSort={onSort}
                    className="hidden xl:table-cell"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((l) => (
                  <TableRow key={l.id} data-state={selected.has(l.id) ? 'selected' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Seleccionar ${l.displayName}`}
                        className="size-4 accent-primary"
                        checked={selected.has(l.id)}
                        onChange={(e) => toggle(l.id, e.target.checked)}
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/sales/accounts/${l.id}`}
                        className="font-medium hover:underline"
                      >
                        {l.displayName}
                      </Link>
                      {l.salesNew && (
                        <Badge className="ml-1.5 bg-sky-600 text-white hover:bg-sky-600">
                          Nuevo para ti
                        </Badge>
                      )}
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {l.contactName && l.companyName && <span>{l.contactName}</span>}
                        {l.city && <span>· {l.city}</span>}
                        {l.phone && (
                          <span>
                            · <PhoneLink phone={l.phone} />
                          </span>
                        )}
                        <TemperatureBadge value={l.salesProfile?.temperature} />
                        {l.salesBatch && <span>· Lote «{l.salesBatch}»</span>}
                      </div>
                      <ProfileGlance profile={l.salesProfile} />
                    </TableCell>
                    <TableCell>
                      <LeadPriority lead={l} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-xs">{PLATFORM_LEAD_STAGE_LABELS[l.status]}</span>
                        {l.tenantStatus && <TenantStatusBadge status={l.tenantStatus} />}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {relativeDays(l.salesProfile?.lastContactAt ?? l.lastActivityAt)}
                    </TableCell>
                    <TableCell className="hidden text-xs lg:table-cell">
                      {l.nextFollowup ? (
                        <>
                          {l.nextFollowup.title}
                          <span className="block text-muted-foreground">
                            {relativeDays(l.nextFollowup.dueDate)}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                      {l.salesAssignedAt ? formatDate(l.salesAssignedAt) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {leads.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={leads.isFetchingNextPage}
                onClick={() => void leads.fetchNextPage()}
              >
                {leads.isFetchingNextPage && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Cargar más
              </Button>
            </div>
          )}
        </>
      )}

      {selected.size > 0 && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur md:sticky md:bottom-4 md:rounded-lg md:border">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {selected.size === 1 ? '1 seleccionado' : `${selected.size} seleccionados`}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Quitar
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    Acciones
                    <ChevronDown className="ml-1 size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setBulk('followup')}>
                    Programar un seguimiento
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setBulk('cadence')}>
                    Meter en una cadencia
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setBulk('move')}>
                    Cambiar de fase
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setBulk('lose')}>
                    Marcar como no interesado
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      )}
      <BulkDialog
        kind={bulk}
        leadIds={[...selected]}
        onClose={() => setBulk(null)}
        onDone={() => setSelected(new Set())}
      />
    </div>
  );
}
