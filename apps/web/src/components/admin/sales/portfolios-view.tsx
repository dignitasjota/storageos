'use client';

import {
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_STAGES,
  SALES_PORTFOLIO_KIND_LABELS,
  SALES_PORTFOLIO_KINDS,
  SALES_PORTFOLIO_NO_REP,
  SALES_PORTFOLIO_SCOPE_LABELS,
  SALES_PORTFOLIO_SCOPES,
  SALES_PORTFOLIO_SORT_DEFAULT_DIR,
  SALES_PORTFOLIO_SORT_LABELS,
  SALES_PORTFOLIO_SORTS,
  SALES_SOURCE_LABELS,
  SALES_TEMPERATURE_LABELS,
  type PlatformLeadStage,
  type SalesLeadTemperatureFilter,
  type SalesPortfolioKind,
  type SalesPortfolioRowDto,
  type SalesPortfolioScope,
  type SalesPortfolioSort,
} from '@storageos/shared';
import { ArrowDown, ArrowUp, Download, Loader2, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  Empty,
  errorText,
  QueryError,
  relativeDays,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { PhoneLink, ScoreBadge } from '@/components/admin/sales/portfolio';
import { PortfolioSheet } from '@/components/admin/sales/portfolio-sheet';
import { Badge } from '@/components/ui/badge';
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
import {
  fetchSalesPortfoliosExport,
  useSalesPortfolios,
  type SalesPortfoliosParams,
} from '@/lib/admin/sales-team-hooks';
import { downloadCsv } from '@/lib/csv';
import { formatDate, formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = 'all';
/** Días sin tocar a partir de los que se marca en rojo. */
const STALE_DAYS = 14;
const UNTOUCHED_OPTIONS = [7, 14, 30, 60, 90];

export interface PortfolioFilters {
  search: string;
  /** Un comercial, «sin comercial» o (null) todos. */
  rep: string | null;
  status: PlatformLeadStage | null;
  batch: string | null;
  temperature: SalesLeadTemperatureFilter | null;
  untouchedDays: number | null;
  neverContacted: boolean;
  scope: SalesPortfolioScope;
  kind: SalesPortfolioKind;
  sort: SalesPortfolioSort;
  dir: 'asc' | 'desc';
}

export const EMPTY_PORTFOLIO_FILTERS: PortfolioFilters = {
  search: '',
  rep: null,
  status: null,
  batch: null,
  temperature: null,
  untouchedDays: null,
  neverContacted: false,
  scope: 'active',
  kind: 'all',
  sort: 'untouched',
  dir: 'desc',
};

const TEMPERATURE_OPTIONS: { value: SalesLeadTemperatureFilter; label: string }[] = [
  { value: 'hot', label: SALES_TEMPERATURE_LABELS.hot },
  { value: 'warm', label: SALES_TEMPERATURE_LABELS.warm },
  { value: 'cold', label: SALES_TEMPERATURE_LABELS.cold },
  { value: 'none', label: 'Sin marcar' },
];

function useDebounced(value: string, ms = 300): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function toParams(f: PortfolioFilters, search: string, fixedRep?: string): SalesPortfoliosParams {
  const rep = fixedRep ?? f.rep;
  return {
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    ...(rep ? { rep } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.batch ? { batch: f.batch } : {}),
    ...(f.temperature ? { temperature: f.temperature } : {}),
    ...(f.untouchedDays ? { untouchedDays: String(f.untouchedDays) } : {}),
    ...(f.neverContacted ? { neverContacted: 'true' } : {}),
    ...(f.scope !== 'active' ? { scope: f.scope } : {}),
    ...(f.kind !== 'all' ? { kind: f.kind } : {}),
    sort: f.sort,
    dir: f.dir,
  };
}

function lastContactText(r: SalesPortfolioRowDto): string {
  return r.lastContactAt ? relativeDays(r.lastContactAt) : 'Nunca';
}

function nextStepText(r: SalesPortfolioRowDto): { title: string; when: string | null } | null {
  if (r.nextFollowup) {
    return { title: r.nextFollowup.title, when: relativeDays(r.nextFollowup.dueDate) };
  }
  if (r.salesProfile?.nextAction) return { title: r.salesProfile.nextAction, when: null };
  return null;
}

function ValueText({ r }: { r: SalesPortfolioRowDto }) {
  if (r.clientMonthly !== null) {
    return <span className="tabular-nums">{formatEur(r.clientMonthly)}/mes</span>;
  }
  if (r.estimatedMonthly !== null) {
    return (
      <span className="tabular-nums text-muted-foreground">
        ≈ {formatEur(r.estimatedMonthly)}/mes
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function UntouchedText({ r }: { r: SalesPortfolioRowDto }) {
  return (
    <span
      className={cn(
        'tabular-nums',
        r.daysUntouched >= STALE_DAYS && r.status !== 'lost' && 'font-medium text-rose-600',
      )}
    >
      {r.daysUntouched} {r.daysUntouched === 1 ? 'día' : 'días'}
    </span>
  );
}

function ArchiveTag({ r }: { r: SalesPortfolioRowDto }) {
  if (!r.salesArchivedAt) return null;
  return (
    <Badge variant="secondary" className="font-normal">
      {r.doNotContact
        ? 'Archivado · no volver a contactar'
        : r.salesRecoverOn
          ? `Archivado · vuelve el ${formatDate(r.salesRecoverOn)}`
          : 'Archivado'}
    </Badge>
  );
}

function SortHead({
  label,
  sortKey,
  filters,
  onSort,
  className,
}: {
  label: string;
  sortKey: SalesPortfolioSort;
  filters: PortfolioFilters;
  onSort: (key: SalesPortfolioSort) => void;
  className?: string;
}) {
  const active = filters.sort === sortKey;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (filters.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
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
          (filters.dir === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          ))}
      </button>
    </TableHead>
  );
}

function csvRows(rows: SalesPortfolioRowDto[]): (string | number)[][] {
  const header = [
    'Cuenta',
    'Persona',
    'Email',
    'Teléfono',
    'Ciudad',
    'Comercial',
    'Fase',
    'Estado de la cuenta',
    'Temperatura',
    'Último contacto',
    'Días sin tocar',
    'Siguiente paso',
    'Fecha del siguiente paso',
    'Cuota prevista (€/mes)',
    'Paga al mes (€)',
    'Lote',
    'Asignado el',
    'Origen',
    'Archivado el',
    'Volver a intentarlo',
    'No volver a contactar',
  ];
  return [
    header,
    ...rows.map((r) => [
      r.displayName,
      r.companyName ? (r.contactName ?? '') : '',
      r.email ?? '',
      r.phone ?? '',
      r.city ?? '',
      r.salesRepName ?? 'Sin comercial',
      PLATFORM_LEAD_STAGE_LABELS[r.status],
      r.tenantStatus ?? '',
      r.salesProfile?.temperature ? SALES_TEMPERATURE_LABELS[r.salesProfile.temperature] : '',
      r.lastContactAt ? formatDate(r.lastContactAt) : 'Nunca',
      r.daysUntouched,
      r.nextFollowup?.title ?? r.salesProfile?.nextAction ?? '',
      r.nextFollowup ? formatDate(r.nextFollowup.dueDate) : '',
      r.estimatedMonthly ?? '',
      r.clientMonthly ?? '',
      r.salesBatch ?? '',
      r.salesAssignedAt ? formatDate(r.salesAssignedAt) : '',
      r.assignedSource ? (SALES_SOURCE_LABELS[r.assignedSource] ?? r.assignedSource) : '',
      r.salesArchivedAt ? formatDate(r.salesArchivedAt) : '',
      r.salesRecoverOn ? formatDate(r.salesRecoverOn) : '',
      r.doNotContact ? 'Sí' : '',
    ]),
  ];
}

/**
 * La tabla de Carteras: todos los prospectos y clientes de los comerciales (o
 * de uno, `fixedRep`), con el embudo por fases y los sin tocar arriba, filtros
 * y orden en el servidor, «Cargar más», CSV y la ficha en un panel lateral.
 */
export function PortfoliosView({
  fixedRep,
  initial,
  csvName = 'carteras',
}: {
  fixedRep?: string;
  initial?: Partial<PortfolioFilters>;
  csvName?: string;
}) {
  const [filters, setFilters] = useState<PortfolioFilters>({
    ...EMPTY_PORTFOLIO_FILTERS,
    ...initial,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const search = useDebounced(filters.search);
  const params = useMemo(() => toParams(filters, search, fixedRep), [filters, search, fixedRep]);
  const query = useSalesPortfolios(params);
  const first = query.data?.pages[0];
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const set = (patch: Partial<PortfolioFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const onSort = (key: SalesPortfolioSort) =>
    setFilters((f) => ({
      ...f,
      sort: key,
      dir:
        f.sort === key ? (f.dir === 'asc' ? 'desc' : 'asc') : SALES_PORTFOLIO_SORT_DEFAULT_DIR[key],
    }));
  const filtersOn =
    !!filters.search ||
    (!fixedRep && !!filters.rep) ||
    !!filters.status ||
    !!filters.batch ||
    !!filters.temperature ||
    !!filters.untouchedDays ||
    filters.neverContacted ||
    filters.scope !== 'active' ||
    filters.kind !== 'all';

  async function exportCsv() {
    setExporting(true);
    try {
      const rows = await fetchSalesPortfoliosExport(params);
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      downloadCsv(`${csvName}-${day}.csv`, csvRows(rows));
      if (rows.length >= 5000) toast.info('El CSV trae las 5.000 primeras filas.');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido descargar.'));
    } finally {
      setExporting(false);
    }
  }

  const funnel = first?.funnel;
  const chip = (active: boolean) =>
    cn(
      'shrink-0 rounded-full border px-3 py-1 text-xs',
      active ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
    );

  return (
    <div className="space-y-4">
      {/* Embudo por fases, archivados y sin tocar. */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <button
          type="button"
          className={chip(!filters.status && filters.scope === 'active' && !filters.neverContacted)}
          onClick={() => set({ status: null, scope: 'active', neverContacted: false })}
        >
          Activos
        </button>
        {PLATFORM_LEAD_STAGES.filter((s) => s !== 'lost').map((s) => (
          <button
            key={s}
            type="button"
            className={chip(filters.status === s)}
            onClick={() => set({ status: filters.status === s ? null : s, scope: 'active' })}
          >
            {PLATFORM_LEAD_STAGE_LABELS[s]}
            {funnel ? ` · ${funnel[s]}` : ''}
          </button>
        ))}
        <button
          type="button"
          className={chip(filters.scope === 'archived')}
          onClick={() =>
            set({ scope: filters.scope === 'archived' ? 'active' : 'archived', status: null })
          }
        >
          Archivados{first ? ` · ${first.archived}` : ''}
        </button>
      </div>

      {first && first.untouched > 0 && !filters.neverContacted && (
        <button
          type="button"
          onClick={() =>
            set({ neverContacted: true, scope: 'active', status: null, kind: 'prospects' })
          }
          className="w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {first.untouched === 1
            ? 'Un prospecto abierto sigue sin que nadie haya hablado con él.'
            : `${first.untouched} prospectos abiertos siguen sin que nadie haya hablado con ellos.`}{' '}
          Verlos
        </button>
      )}

      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar por empresa, persona, email, teléfono o ciudad"
              value={filters.search}
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={exporting || !first || first.total === 0}
            onClick={() => void exportCsv()}
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin sm:mr-1.5" />
            ) : (
              <Download className="size-4 sm:mr-1.5" />
            )}
            <span className="hidden sm:inline">CSV</span>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {!fixedRep && (
            <Select
              value={filters.rep ?? ALL}
              onValueChange={(v) => set({ rep: v === ALL ? null : v })}
            >
              <SelectTrigger className="col-span-2 sm:w-[220px]" aria-label="Comercial">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los comerciales</SelectItem>
                <SelectItem value={SALES_PORTFOLIO_NO_REP}>
                  Sin comercial{first ? ` · ${first.noRep}` : ''}
                </SelectItem>
                {(first?.reps ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                    {!r.isActive && ' (desactivado)'} · {r.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={filters.temperature ?? ALL}
            onValueChange={(v) =>
              set({ temperature: v === ALL ? null : (v as SalesLeadTemperatureFilter) })
            }
          >
            <SelectTrigger className="sm:w-[170px]" aria-label="Temperatura">
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
            value={filters.neverContacted ? 'never' : String(filters.untouchedDays ?? ALL)}
            onValueChange={(v) =>
              v === 'never'
                ? set({ neverContacted: true, untouchedDays: null })
                : set({ neverContacted: false, untouchedDays: v === ALL ? null : Number(v) })
            }
          >
            <SelectTrigger className="sm:w-[200px]" aria-label="Sin tocar">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tocados o no</SelectItem>
              <SelectItem value="never">Nunca contactados</SelectItem>
              {UNTOUCHED_OPTIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  Sin tocar en {d} días
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {((first?.batches.length ?? 0) > 0 || filters.batch) && (
            <Select
              value={filters.batch ?? ALL}
              onValueChange={(v) => set({ batch: v === ALL ? null : v })}
            >
              <SelectTrigger className="sm:w-[190px]" aria-label="Lote">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos los lotes</SelectItem>
                {filters.batch && !first?.batches.some((b) => b.name === filters.batch) && (
                  <SelectItem value={filters.batch}>{filters.batch}</SelectItem>
                )}
                {(first?.batches ?? []).map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {b.name} · {b.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={filters.kind}
            onValueChange={(v) => set({ kind: v as SalesPortfolioKind })}
          >
            <SelectTrigger className="sm:w-[190px]" aria-label="Prospectos o clientes">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SALES_PORTFOLIO_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {SALES_PORTFOLIO_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.scope}
            onValueChange={(v) => set({ scope: v as SalesPortfolioScope })}
          >
            <SelectTrigger className="sm:w-[190px]" aria-label="Archivados">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SALES_PORTFOLIO_SCOPES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SALES_PORTFOLIO_SCOPE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <Select value={filters.sort} onValueChange={(v) => onSort(v as SalesPortfolioSort)}>
              <SelectTrigger className="flex-1 sm:w-[200px]" aria-label="Ordenar por">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SALES_PORTFOLIO_SORTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    Ordenar: {SALES_PORTFOLIO_SORT_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              aria-label={filters.dir === 'asc' ? 'De menos a más' : 'De más a menos'}
              title={filters.dir === 'asc' ? 'De menos a más' : 'De más a menos'}
              onClick={() => set({ dir: filters.dir === 'asc' ? 'desc' : 'asc' })}
            >
              {filters.dir === 'asc' ? (
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
              onClick={() =>
                setFilters({ ...EMPTY_PORTFOLIO_FILTERS, sort: filters.sort, dir: filters.dir })
              }
            >
              <X className="mr-1 size-4" />
              Quitar filtros
            </Button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : query.isError ? (
        <QueryError query={query} />
      ) : items.length === 0 ? (
        <Empty>No hay cuentas con estos filtros.</Empty>
      ) : (
        <>
          <p className="text-right text-xs tabular-nums text-muted-foreground">
            {items.length} de {first?.total ?? items.length}
          </p>

          {/* Móvil: tarjetas. */}
          <div className="space-y-2 md:hidden">
            {items.map((r) => {
              const next = nextStepText(r);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className="w-full rounded-lg border bg-card p-3 text-left text-sm shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-words font-medium">{r.displayName}</span>
                    <ScoreBadge score={r.score} className="shrink-0" />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {!fixedRep && <span>{r.salesRepName ?? 'Sin comercial'}</span>}
                    <span>{PLATFORM_LEAD_STAGE_LABELS[r.status]}</span>
                    {r.tenantStatus && <TenantStatusBadge status={r.tenantStatus} />}
                    <TemperatureBadge value={r.salesProfile?.temperature} />
                    <ValueText r={r} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Último contacto: {lastContactText(r)} · sin tocar <UntouchedText r={r} />
                  </p>
                  {next && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      → {next.title}
                      {next.when && ` (${next.when})`}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    <ArchiveTag r={r} />
                    {r.salesBatch && (
                      <Badge variant="outline" className="font-normal">
                        Lote «{r.salesBatch}»
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Escritorio: tabla. */}
          <div className="hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cuenta</TableHead>
                  {!fixedRep && (
                    <SortHead label="Comercial" sortKey="rep" filters={filters} onSort={onSort} />
                  )}
                  <SortHead label="Fase" sortKey="stage" filters={filters} onSort={onSort} />
                  <TableHead>Último contacto</TableHead>
                  <SortHead
                    label="Sin tocar"
                    sortKey="untouched"
                    filters={filters}
                    onSort={onSort}
                  />
                  <SortHead
                    label="Siguiente paso"
                    sortKey="next_step"
                    filters={filters}
                    onSort={onSort}
                    className="hidden lg:table-cell"
                  />
                  <SortHead
                    label="Valor"
                    sortKey="value"
                    filters={filters}
                    onSort={onSort}
                    className="text-right"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => {
                  const next = nextStepText(r);
                  return (
                    <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpenId(r.id)}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId(r.id);
                          }}
                        >
                          {r.displayName}
                        </button>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {r.contactName && r.companyName && <span>{r.contactName}</span>}
                          {r.city && <span>· {r.city}</span>}
                          {r.phone && (
                            <span>
                              · <PhoneLink phone={r.phone} />
                            </span>
                          )}
                          <TemperatureBadge value={r.salesProfile?.temperature} />
                          {r.salesBatch && <span>· Lote «{r.salesBatch}»</span>}
                          <ArchiveTag r={r} />
                        </div>
                      </TableCell>
                      {!fixedRep && (
                        <TableCell className="text-xs">
                          {r.salesRepName ?? (
                            <span className="text-muted-foreground">Sin comercial</span>
                          )}
                          {r.salesRepActive === false && (
                            <span className="block text-muted-foreground">desactivado</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-xs">{PLATFORM_LEAD_STAGE_LABELS[r.status]}</span>
                          {r.tenantStatus && <TenantStatusBadge status={r.tenantStatus} />}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {lastContactText(r)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <UntouchedText r={r} />
                      </TableCell>
                      <TableCell className="hidden text-xs lg:table-cell">
                        {next ? (
                          <>
                            {next.title}
                            {next.when && (
                              <span className="block text-muted-foreground">{next.when}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <ValueText r={r} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Cargar más
              </Button>
            </div>
          )}
        </>
      )}

      <PortfolioSheet leadId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
