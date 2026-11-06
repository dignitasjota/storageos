'use client';

import {
  type FacilityDto,
  type FacilityFloorDto,
  UNIT_FEATURE_LABELS,
  type UnitFeature,
  type UnitOverviewRowDto,
  type UnitStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import {
  Columns3,
  Download,
  LayoutGrid,
  Map as MapIcon,
  MoreHorizontal,
  Save,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { InventoryIssuesBanner } from './inventory-issues-banner';
import {
  EMPTY_FILTERS,
  FILTER_TOGGLES,
  matchesUnit,
  PRESET_VIEWS,
  type UnitListFilters,
} from './unit-filters';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { BulkUnitsBar } from '@/components/units/bulk-actions-bar';
import { BulkCreateUnitsDialog } from '@/components/units/bulk-create-dialog';
import { ChangeUnitStatusDialog } from '@/components/units/change-status-dialog';
import { CreateUnitDialog } from '@/components/units/create-unit-dialog';
import { useDeleteUnitAction } from '@/components/units/use-delete-unit';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useFacilities, useFloors, useUnitTypes } from '@/lib/facilities/hooks';
import {
  useDeleteUnitView,
  useSaveUnitView,
  useUnitsOverview,
  useUnitViews,
} from '@/lib/facilities/inventory-hooks';
import { useFacilityStore } from '@/lib/facilities/store';
import { formatEur, formatNumber } from '@/lib/format';

// Konva no funciona en SSR; el plano se carga solo en cliente.
const PlanViewer = dynamic(() => import('./plan-viewer').then((m) => m.PlanViewer), {
  ssr: false,
});

/** Tiles de resumen por estado (colores alineados con el dashboard). */
const STATUS_KPIS: { status: UnitStatusValue; label: string; color: string }[] = [
  { status: 'available', label: 'Disponibles', color: '#64748b' },
  { status: 'occupied', label: 'Ocupados', color: '#16a34a' },
  { status: 'reserved', label: 'Reservados', color: '#eab308' },
  { status: 'maintenance', label: 'Mantenimiento', color: '#f97316' },
  { status: 'blocked', label: 'Bloqueados', color: '#dc2626' },
];

const STATUS_LABELS: Record<UnitStatusValue, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

type ColumnKey =
  | 'facility'
  | 'floor'
  | 'type'
  | 'area'
  | 'price'
  | 'tenant'
  | 'fee'
  | 'days'
  | 'debt';

const COLUMN_LABELS: [ColumnKey, string][] = [
  ['facility', 'Local'],
  ['floor', 'Planta'],
  ['type', 'Tipo'],
  ['area', 'm²'],
  ['price', 'Precio'],
  ['tenant', 'Inquilino'],
  ['fee', 'Cuota'],
  ['days', 'Días libre o parado'],
  ['debt', 'Deuda'],
];
const DEFAULT_COLUMNS: ColumnKey[] = ['facility', 'type', 'area', 'price', 'tenant', 'days'];
const COLUMNS_KEY = 'storageos.units.columns';

function readColumns(): ColumnKey[] {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    return raw ? (JSON.parse(raw) as ColumnKey[]) : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

function writeColumns(columns: ColumnKey[]) {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    /* sin almacenamiento */
  }
}

const featureLabel = (f: string) => UNIT_FEATURE_LABELS[f as UnitFeature] ?? f;

export default function UnitsPage() {
  const ask = useConfirm();
  const switcherFacility = useFacilityStore((s) => s.currentFacilityId);
  const setCurrentFacility = useFacilityStore((s) => s.setCurrentFacility);
  const [facilityId, setFacilityId] = useState<string | undefined>(switcherFacility ?? undefined);
  const [filters, setFilters] = useState<UnitListFilters>(EMPTY_FILTERS);
  const set = <K extends keyof UnitListFilters>(k: K, v: UnitListFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));
  // Selecciona un local y lo recuerda (persistido en el store, compartido con
  // el selector de local de la cabecera) para retomarlo en la próxima visita.
  const selectFacility = useCallback(
    (id: string | undefined) => {
      setFacilityId(id);
      setFilters((f) => ({ ...f, floorId: 'all' }));
      setCurrentFacility(id ?? null);
    },
    [setCurrentFacility],
  );
  const [view, setView] = useState<'table' | 'plan'>('table');
  const [floorId, setFloorId] = useState<string | undefined>();
  const [focusUnitId, setFocusUnitId] = useState<string | undefined>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [columnsOn, setColumnsOn] = useState<ColumnKey[]>(DEFAULT_COLUMNS);

  // Sigue el local elegido en la cabecera (como el resto del panel).
  useEffect(() => {
    setFacilityId(switcherFacility ?? undefined);
    setFilters((f) => ({ ...f, floorId: 'all' }));
  }, [switcherFacility]);

  useEffect(() => {
    setColumnsOn(readColumns());
    // «Ver en el plano» desde la ficha: abre el plano en ese trastero.
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'plan') setView('plan');
    const facility = params.get('facility');
    if (facility) setFacilityId(facility);
    const floor = params.get('floor');
    if (floor) setFloorId(floor);
    const unit = params.get('unit');
    if (unit) setFocusUnitId(unit);
  }, []);

  const facilities = useFacilities();
  const types = useUnitTypes();
  const floors = useFloors(facilityId);
  const views = useUnitViews();
  const saveViewMutation = useSaveUnitView();
  const deleteViewMutation = useDeleteUnitView();

  // El local recordado (en este navegador) puede ya no existir —borrado o de
  // otra cuenta—: filtrar por él dejaba la lista vacía sin explicación.
  useEffect(() => {
    if (facilityId && facilities.data && !facilities.data.some((f) => f.id === facilityId)) {
      selectFacility(undefined);
    }
  }, [facilities.data, facilityId, selectFacility]);

  // Si solo hay un local, lo selecciona automáticamente (no hace falta elegirlo).
  useEffect(() => {
    if (!facilityId && facilities.data && facilities.data.length === 1) {
      selectFacility(facilities.data[0]!.id);
    }
  }, [facilities.data, facilityId, selectFacility]);

  const overview = useUnitsOverview(facilityId);
  const moneyVisible = overview.data?.moneyVisible ?? false;
  const tenantsVisible = overview.data?.tenantsVisible ?? false;
  const allUnits = useMemo(
    () =>
      [...(overview.data?.rows ?? [])].sort((a, b) =>
        a.code.localeCompare(b.code, 'es', { numeric: true }),
      ),
    [overview.data?.rows],
  );
  // Las tiras de estado cuentan lo que dejan los demás filtros.
  const filtered = useMemo(
    () => allUnits.filter((u) => matchesUnit(u, filters)),
    [allUnits, filters],
  );
  const rows = useMemo(
    () =>
      filters.status === 'all' ? filtered : filtered.filter((u) => u.status === filters.status),
    [filtered, filters.status],
  );
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<UnitStatusValue, number>> = {};
    for (const u of filtered) counts[u.status] = (counts[u.status] ?? 0) + 1;
    return counts;
  }, [filtered]);
  const stopped = useMemo(() => filtered.filter((u) => u.outOfService), [filtered]);
  const lostIncome = stopped.reduce((sum, u) => sum + (u.outOfService?.lostIncome ?? 0), 0);

  const canWrite = useHasPermission('units:write');
  const canDelete = useHasPermission('units:manage');
  const deleteUnit = useDeleteUnitAction();
  const [target, setTarget] = useState<UnitOverviewRowDto | null>(null);
  const [copyFrom, setCopyFrom] = useState<UnitOverviewRowDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visibleIds = rows.map((u) => u.id);
  const visibleKey = visibleIds.join(',');
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const show = (k: ColumnKey) => columnsOn.includes(k);

  function toggleColumn(k: ColumnKey) {
    const next = show(k) ? columnsOn.filter((c) => c !== k) : [...columnsOn, k];
    setColumnsOn(next);
    writeColumns(next);
  }

  const columns: ColumnDef<UnitOverviewRowDto>[] = useMemo(() => {
    const on = (k: ColumnKey) => columnsOn.includes(k);
    const list: (ColumnDef<UnitOverviewRowDto> | false)[] = [
      canWrite && {
        id: 'select',
        header: () => (
          <Checkbox
            aria-label="Seleccionar todos"
            checked={allSelected}
            onCheckedChange={(v) => setSelected(v === true ? new Set(visibleIds) : new Set())}
          />
        ),
        meta: { mobileHidden: true },
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Seleccionar ${row.original.code}`}
            checked={selected.has(row.original.id)}
            onCheckedChange={() => toggle(row.original.id)}
          />
        ),
      },
      {
        accessorKey: 'code',
        header: 'Código',
        sortingFn: 'alphanumeric',
        cell: ({ row }) => (
          <Link href={`/units/${row.original.id}`} className="font-medium hover:underline">
            {row.original.code}
          </Link>
        ),
      },
      on('facility') && {
        accessorKey: 'facilityName',
        header: 'Local',
        cell: ({ row }) => (
          <Link href={`/facilities/${row.original.facilityId}`} className="hover:underline">
            {row.original.facilityName}
          </Link>
        ),
      },
      on('floor') && { accessorKey: 'floorName', header: 'Planta' },
      on('type') && {
        accessorKey: 'unitTypeName',
        header: 'Tipo',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span
              className="inline-block size-3 rounded-sm border"
              style={{ backgroundColor: row.original.unitTypeColor }}
            />
            {row.original.unitTypeName}
          </div>
        ),
      },
      on('area') && {
        accessorKey: 'areaM2',
        header: 'm²',
        cell: ({ row }) => formatNumber(row.original.areaM2),
      },
      on('price') && {
        accessorKey: 'basePriceMonthly',
        header: 'Precio',
        cell: ({ row }) => formatEur(row.original.basePriceMonthly),
      },
      on('tenant') &&
        tenantsVisible && {
          id: 'tenant',
          header: 'Inquilino',
          accessorFn: (u) => u.tenant?.customerName ?? '',
          cell: ({ row }) =>
            row.original.tenant ? (
              <Link
                href={`/customers/${row.original.tenant.customerId}`}
                className="hover:underline"
              >
                {row.original.tenant.customerName}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        },
      on('fee') &&
        tenantsVisible && {
          id: 'fee',
          header: 'Cuota',
          accessorFn: (u) => u.tenant?.monthly ?? -1,
          cell: ({ row }) => {
            const u = row.original;
            if (!u.tenant) return <span className="text-muted-foreground">—</span>;
            const gap = u.tenant.monthly - u.basePriceMonthly;
            return (
              <span>
                {formatEur(u.tenant.monthly)}
                {Math.abs(gap) >= 0.01 && (
                  <span className="block text-xs text-muted-foreground">
                    {gap > 0 ? '+' : '−'}
                    {formatEur(Math.abs(gap))} sobre catálogo
                  </span>
                )}
              </span>
            );
          },
        },
      on('days') && {
        id: 'days',
        header: 'Libre o parado',
        accessorFn: (u) => u.daysVacant ?? u.outOfService?.days ?? -1,
        cell: ({ row }) => {
          const u = row.original;
          if (u.daysVacant !== null) {
            return <span className="whitespace-nowrap">Libre {u.daysVacant} d</span>;
          }
          if (u.outOfService) {
            return <span className="whitespace-nowrap">Parado {u.outOfService.days} d</span>;
          }
          return <span className="text-muted-foreground">—</span>;
        },
      },
      on('debt') &&
        moneyVisible && {
          id: 'debt',
          header: 'Deuda',
          accessorFn: (u) => u.tenant?.overdue ?? 0,
          cell: ({ row }) => {
            const overdue = row.original.tenant?.overdue ?? 0;
            return overdue > 0 ? (
              <span className="font-medium text-destructive">{formatEur(overdue)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          },
        },
      {
        accessorKey: 'status',
        header: 'Estado',
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge status={row.original.status} />
            {row.original.offer && <Badge variant="secondary">Oferta</Badge>}
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        meta: { mobileHidden: !canWrite && !canDelete },
        cell: ({ row }) => {
          const u = row.original;
          // Un trastero ocupado lo llevan sus contratos.
          const canChange = canWrite && u.status !== 'occupied';
          const canRemove = canDelete && u.status !== 'occupied';
          if (!canChange && !canRemove && !canWrite) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Acciones">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canChange && (
                  <DropdownMenuItem onClick={() => setTarget(u)}>Cambiar estado</DropdownMenuItem>
                )}
                {canWrite && (
                  <DropdownMenuItem onClick={() => setCopyFrom(u)}>Duplicar</DropdownMenuItem>
                )}
                {canRemove && (
                  <DropdownMenuItem className="text-destructive" onClick={() => void deleteUnit(u)}>
                    Borrar
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ];
    return list.filter((c): c is ColumnDef<UnitOverviewRowDto> => c !== false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canWrite,
    canDelete,
    selected,
    allSelected,
    visibleKey,
    columnsOn,
    tenantsVisible,
    moneyVisible,
  ]);

  const activeFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  function exportCsv() {
    downloadCsv('trasteros.csv', [
      [
        'Código',
        'Local',
        'Planta',
        'Tipo',
        'm²',
        'Precio sin IVA',
        'Estado',
        ...(tenantsVisible ? ['Inquilino', 'Contrato', 'Cuota sin IVA'] : []),
        ...(moneyVisible ? ['Deuda'] : []),
        'Días libre',
        'Días parado',
        'Motivo',
        'Características',
      ],
      ...rows.map((u) => [
        u.code,
        u.facilityName,
        u.floorName,
        u.unitTypeName,
        u.areaM2,
        u.basePriceMonthly,
        STATUS_LABELS[u.status],
        ...(tenantsVisible
          ? [u.tenant?.customerName ?? '', u.tenant?.contractNumber ?? '', u.tenant?.monthly ?? '']
          : []),
        ...(moneyVisible ? [u.tenant?.overdue ?? ''] : []),
        u.daysVacant ?? '',
        u.outOfService?.days ?? '',
        u.outOfServiceReason ?? '',
        u.features.map(featureLabel).join(', '),
      ]),
    ]);
  }

  async function saveView() {
    const res = await ask({
      title: 'Guardar vista',
      description: 'La verá todo el equipo, con los filtros actuales.',
      input: { label: 'Nombre de la vista', placeholder: 'p. ej. Grandes libres del local Norte' },
      confirmLabel: 'Guardar',
    });
    const name = res ? res.value.trim() : '';
    if (!name) return;
    try {
      await saveViewMutation.mutateAsync({
        name,
        filters: { ...filters, ...(facilityId ? { facilityId } : {}) },
      });
      toast.success('Vista guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  function applyView(saved: Record<string, unknown>) {
    const { facilityId: viewFacility, ...rest } = saved as Partial<UnitListFilters> & {
      facilityId?: string;
    };
    if (viewFacility) selectFacility(viewFacility);
    setFilters({ ...EMPTY_FILTERS, ...rest });
  }

  const selectedUnits = rows.filter((u) => selected.has(u.id));

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <InventoryIssuesBanner />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trasteros</h1>
          <p className="text-sm text-muted-foreground">
            Vista global de todos tus trasteros con filtros.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border p-0.5">
            <Button
              variant={view === 'table' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => setView('table')}
            >
              <LayoutGrid className="h-4 w-4" /> Tabla
            </Button>
            <Button
              variant={view === 'plan' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => setView('plan')}
            >
              <MapIcon className="h-4 w-4" /> Plano
            </Button>
          </div>
          <Can permission="imports:manage">
            <Button asChild variant="outline">
              <Link href="/units/import">
                <Upload className="mr-1 h-4 w-4" /> Importar
              </Link>
            </Button>
          </Can>
          <Can permission="units:write">
            <BulkCreateUnitsDialog />
            <CreateUnitDialog />
          </Can>
        </div>
      </div>

      {allUnits.length > 0 && (
        // En el móvil, una tira compacta que se desliza (antes, cinco tarjetas
        // grandes ocupaban la pantalla antes del primer trastero).
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-3 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-5">
          {STATUS_KPIS.map((k) => {
            const count = statusCounts[k.status] ?? 0;
            const active = filters.status === k.status;
            return (
              <button
                key={k.status}
                type="button"
                onClick={() => set('status', active ? 'all' : k.status)}
                aria-pressed={active}
                className={`shrink-0 rounded-xl border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/50 sm:p-4 ${
                  active ? 'ring-2 ring-primary' : ''
                }`}
              >
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ backgroundColor: k.color }}
                  />
                  {k.label}
                </span>
                <span className="mt-0.5 block text-lg font-semibold tabular-nums sm:mt-1 sm:text-2xl">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {stopped.length > 0 && (
        <button
          type="button"
          onClick={() => set('stopped', !filters.stopped)}
          className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950"
        >
          <strong>{stopped.length}</strong> fuera de servicio
          {lostIncome > 0 && (
            <>
              {' '}
              · <strong>{formatEur(lostIncome)}</strong> sin ingresar hasta hoy, al precio de
              catálogo
            </>
          )}
        </button>
      )}

      {view === 'table' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {(facilities.data?.length ?? 0) > 1 && (
              <Select
                value={facilityId ?? 'all'}
                onValueChange={(v) => selectFacility(v === 'all' ? undefined : v)}
              >
                <SelectTrigger className="h-9 w-full sm:w-[190px]" aria-label="Local">
                  <SelectValue placeholder="Local" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos los locales</SelectItem>
                  {(facilities.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={filters.status}
              onValueChange={(v) => set('status', v as UnitListFilters['status'])}
            >
              <SelectTrigger className="h-9 w-full sm:w-[180px]" aria-label="Estado">
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los estados</SelectItem>
                {STATUS_KPIS.map((k) => (
                  <SelectItem key={k.status} value={k.status}>
                    {STATUS_LABELS[k.status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {facilityId && (floors.data ?? []).length > 1 && (
              <Select value={filters.floorId} onValueChange={(v) => set('floorId', v)}>
                <SelectTrigger className="h-9 w-full sm:w-[180px]" aria-label="Planta">
                  <SelectValue placeholder="Planta" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las plantas</SelectItem>
                  {(floors.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={filters.unitTypeId} onValueChange={(v) => set('unitTypeId', v)}>
              <SelectTrigger className="h-9 w-full sm:w-[180px]" aria-label="Tipo">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                {(types.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {FILTER_TOGGLES.filter((t) => t.key !== 'debt' || moneyVisible).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => set(t.key, !filters[t.key])}
                aria-pressed={filters[t.key]}
                className={`h-9 rounded-md border px-3 text-sm transition-colors ${
                  filters[t.key]
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {t.label}
              </button>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setMoreOpen((o) => !o)}
            >
              <SlidersHorizontal className="mr-1 h-4 w-4" /> Más filtros
            </Button>
          </div>

          {moreOpen && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="space-y-1">
                <Label htmlFor="f-vacant" className="text-xs">
                  Libre más de (días)
                </Label>
                <Input
                  id="f-vacant"
                  inputMode="numeric"
                  value={filters.vacantDays}
                  onChange={(e) => set('vacantDays', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="f-min-area" className="text-xs">
                  m² desde
                </Label>
                <Input
                  id="f-min-area"
                  inputMode="decimal"
                  value={filters.minArea}
                  onChange={(e) => set('minArea', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="f-max-area" className="text-xs">
                  m² hasta
                </Label>
                <Input
                  id="f-max-area"
                  inputMode="decimal"
                  value={filters.maxArea}
                  onChange={(e) => set('maxArea', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="f-min-price" className="text-xs">
                  Precio desde (€)
                </Label>
                <Input
                  id="f-min-price"
                  inputMode="decimal"
                  value={filters.minPrice}
                  onChange={(e) => set('minPrice', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="f-max-price" className="text-xs">
                  Precio hasta (€)
                </Label>
                <Input
                  id="f-max-price"
                  inputMode="decimal"
                  value={filters.maxPrice}
                  onChange={(e) => set('maxPrice', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Característica</Label>
                <Select value={filters.feature} onValueChange={(v) => set('feature', v)}>
                  <SelectTrigger className="h-9" aria-label="Característica">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {Object.entries(UNIT_FEATURE_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {canWrite && (
            <BulkUnitsBar
              units={selectedUnits}
              {...(facilityId ? { facilityId } : {})}
              onDone={() => setSelected(new Set())}
            />
          )}
          {overview.isError ? (
            <SectionError onRetry={() => void overview.refetch()} />
          ) : (
            <DataTable
              filtersActive={activeFilters}
              onClearFilters={() => setFilters(EMPTY_FILTERS)}
              rowHref={(u) => `/units/${u.id}`}
              columns={columns}
              data={rows}
              isLoading={overview.isLoading}
              pageSize={50}
              searchPlaceholder={
                tenantsVisible
                  ? 'Buscar por código, inquilino, contrato o notas…'
                  : 'Buscar por código o notas…'
              }
              searchText={(u) =>
                [
                  u.code,
                  u.notes,
                  u.facilityName,
                  u.floorName,
                  u.unitTypeName,
                  u.tenant?.customerName,
                  u.tenant?.contractNumber,
                  ...u.features.map(featureLabel),
                ]
                  .filter(Boolean)
                  .join(' ')
              }
              toolbarRight={
                <>
                  <Button variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
                    <Download className="mr-1 h-4 w-4" /> CSV
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline">Vistas</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuLabel>Vistas rápidas</DropdownMenuLabel>
                      {PRESET_VIEWS.map((v) => (
                        <DropdownMenuItem
                          key={v.name}
                          onSelect={() => setFilters({ ...EMPTY_FILTERS, ...v.filters })}
                        >
                          {v.name}
                        </DropdownMenuItem>
                      ))}
                      {(views.data?.length ?? 0) > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>Vistas del equipo</DropdownMenuLabel>
                          {(views.data ?? []).map((v) => (
                            <DropdownMenuItem
                              key={v.id}
                              onSelect={() => applyView(v.filters)}
                              className="justify-between"
                            >
                              <span className="truncate">{v.name}</span>
                              {canWrite && (
                                <button
                                  type="button"
                                  aria-label={`Borrar la vista ${v.name}`}
                                  className="text-muted-foreground hover:text-destructive"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteViewMutation.mutate(v.id);
                                  }}
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                              )}
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                      {canWrite && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => void saveView()}
                            disabled={!activeFilters}
                          >
                            <Save className="mr-2 size-4" /> Guardar los filtros actuales
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" aria-label="Columnas">
                        <Columns3 className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {COLUMN_LABELS.filter(
                        ([k]) =>
                          (k !== 'tenant' && k !== 'fee' && k !== 'debt') ||
                          (k === 'debt' ? moneyVisible : tenantsVisible),
                      ).map(([k, label]) => (
                        <DropdownMenuCheckboxItem
                          key={k}
                          checked={show(k)}
                          onCheckedChange={() => toggleColumn(k)}
                          onSelect={(e) => e.preventDefault()}
                        >
                          {label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
              guide="importar"
              emptyText="Aún no hay trasteros. Crea el primero con «Nuevo trastero» o impórtalos desde un Excel."
            />
          )}
        </>
      ) : (
        <PlanView
          facilityId={facilityId}
          setFacilityId={selectFacility}
          facilities={facilities.data ?? []}
          floors={floors.data ?? []}
          floorId={floorId}
          setFloorId={setFloorId}
          focusUnitId={focusUnitId}
        />
      )}

      <ChangeUnitStatusDialog unit={target} onClose={() => setTarget(null)} />
      {copyFrom && (
        <CreateUnitDialog
          open
          copyFrom={copyFrom}
          onOpenChange={(o) => !o && setCopyFrom(null)}
          onCreated={() => setCopyFrom(null)}
        />
      )}
    </div>
  );
}

function PlanView({
  facilityId,
  setFacilityId,
  facilities,
  floors,
  floorId,
  setFloorId,
  focusUnitId,
}: {
  facilityId: string | undefined;
  setFacilityId: (v: string | undefined) => void;
  facilities: FacilityDto[];
  floors: FacilityFloorDto[];
  floorId: string | undefined;
  setFloorId: (v: string | undefined) => void;
  focusUnitId: string | undefined;
}) {
  // Planta efectiva: la seleccionada si pertenece al local, si no la primera.
  const effectiveFloorId = floors.some((f) => f.id === floorId) ? floorId : floors[0]?.id;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select
          value={facilityId ?? 'none'}
          onValueChange={(v) => setFacilityId(v === 'none' ? undefined : v)}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Elige un local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Elige un local</SelectItem>
            {facilities.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {facilityId && floors.length > 0 && (
          <Select value={effectiveFloorId ?? ''} onValueChange={(v) => setFloorId(v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Planta" />
            </SelectTrigger>
            <SelectContent>
              {floors.map((fl) => (
                <SelectItem key={fl.id} value={fl.id}>
                  {fl.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {!facilityId ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Elige un local para ver el plano de sus trasteros por planta.
          </CardContent>
        </Card>
      ) : floors.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Este local no tiene plantas. Crea una en el detalle del local → pestaña «Plantas y
            plano».
          </CardContent>
        </Card>
      ) : effectiveFloorId ? (
        <PlanViewer
          facilityId={facilityId}
          floorId={effectiveFloorId}
          {...(focusUnitId ? { focusUnitId } : {})}
        />
      ) : null}
    </div>
  );
}
