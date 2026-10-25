'use client';

import {
  type FacilityDto,
  type FacilityFloorDto,
  type UnitDto,
  type UnitStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { LayoutGrid, Map as MapIcon, MoreHorizontal, Upload } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { InventoryIssuesBanner } from './inventory-issues-banner';

import { Can } from '@/components/auth/can';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useFacilities,
  useFloors,
  useOccupancyDashboard,
  useUnits,
  useUnitTypes,
} from '@/lib/facilities/hooks';
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

export default function UnitsPage() {
  const switcherFacility = useFacilityStore((s) => s.currentFacilityId);
  const setCurrentFacility = useFacilityStore((s) => s.setCurrentFacility);
  const [facilityId, setFacilityId] = useState<string | undefined>(switcherFacility ?? undefined);
  // Selecciona un local y lo recuerda (persistido en el store, compartido con
  // el selector de local de la cabecera) para retomarlo en la próxima visita.
  const selectFacility = useCallback(
    (id: string | undefined) => {
      setFacilityId(id);
      setTableFloorId(undefined);
      setCurrentFacility(id ?? null);
    },
    [setCurrentFacility],
  );
  const [status, setStatus] = useState<UnitStatusValue | undefined>();
  const [unitTypeId, setUnitTypeId] = useState<string | undefined>();
  const [view, setView] = useState<'table' | 'plan'>('table');
  const [floorId, setFloorId] = useState<string | undefined>();
  const [tableFloorId, setTableFloorId] = useState<string | undefined>();

  // Sigue el local elegido en la cabecera (como el resto del panel).
  useEffect(() => {
    setFacilityId(switcherFacility ?? undefined);
    setTableFloorId(undefined);
  }, [switcherFacility]);

  const facilities = useFacilities();
  const types = useUnitTypes();
  const occupancy = useOccupancyDashboard(facilityId);
  const floors = useFloors(facilityId);

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

  const units = useUnits({
    ...(facilityId ? { facilityId } : {}),
    ...(facilityId && tableFloorId ? { floorId: tableFloorId } : {}),
    ...(status ? { status } : {}),
    ...(unitTypeId ? { unitTypeId } : {}),
  });

  const canWrite = useHasPermission('units:write');
  const [target, setTarget] = useState<UnitDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visibleIds = (units.data?.items ?? []).map((u) => u.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: ColumnDef<UnitDto>[] = useMemo(
    () => [
      ...(canWrite
        ? [
            {
              id: 'select',
              header: () => (
                <Checkbox
                  aria-label="Seleccionar todos"
                  checked={allSelected}
                  onCheckedChange={(v) => setSelected(v === true ? new Set(visibleIds) : new Set())}
                />
              ),
              meta: { mobileHidden: true },
              cell: ({ row }: { row: { original: UnitDto } }) => (
                <Checkbox
                  aria-label={`Seleccionar ${row.original.code}`}
                  checked={selected.has(row.original.id)}
                  onCheckedChange={() => toggle(row.original.id)}
                />
              ),
            } as ColumnDef<UnitDto>,
          ]
        : []),
      {
        accessorKey: 'code',
        header: 'Código',
        cell: ({ row }) => (
          <Link href={`/units/${row.original.id}`} className="font-medium hover:underline">
            {row.original.code}
          </Link>
        ),
      },
      {
        accessorKey: 'facilityName',
        header: 'Local',
        cell: ({ row }) => (
          <Link href={`/facilities/${row.original.facilityId}`} className="hover:underline">
            {row.original.facilityName}
          </Link>
        ),
      },
      {
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
      {
        accessorKey: 'areaM2',
        header: 'm²',
        cell: ({ row }) => formatNumber(row.original.areaM2),
      },
      {
        accessorKey: 'basePriceMonthly',
        header: 'Precio',
        cell: ({ row }) => formatEur(row.original.basePriceMonthly),
      },
      {
        accessorKey: 'status',
        header: 'Estado',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'actions',
        header: '',
        meta: { mobileHidden: !canWrite },
        cell: ({ row }) =>
          canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Acciones">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setTarget(row.original)}>
                  Cambiar estado
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, selected, allSelected, visibleIds.join(',')],
  );

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

      {occupancy.data && occupancy.data.totalUnits > 0 && (
        // En el móvil, una tira compacta que se desliza (antes, cinco tarjetas
        // grandes ocupaban la pantalla antes del primer trastero).
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-3 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-5">
          {STATUS_KPIS.map((k) => {
            const count = occupancy.data.byStatus[k.status] ?? 0;
            const active = status === k.status;
            return (
              <button
                key={k.status}
                type="button"
                onClick={() => setStatus(active ? undefined : k.status)}
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

      {view === 'table' ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Select
              value={facilityId ?? 'all'}
              onValueChange={(v) => selectFacility(v === 'all' ? undefined : v)}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
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
            <Select
              value={status ?? 'all'}
              onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as UnitStatusValue))}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los estados</SelectItem>
                {(
                  [
                    'available',
                    'occupied',
                    'reserved',
                    'maintenance',
                    'blocked',
                  ] as UnitStatusValue[]
                ).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {facilityId && (floors.data ?? []).length > 1 && (
              <Select
                value={tableFloorId ?? 'all'}
                onValueChange={(v) => setTableFloorId(v === 'all' ? undefined : v)}
              >
                <SelectTrigger className="w-full sm:w-[200px]">
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
            <Select
              value={unitTypeId ?? 'all'}
              onValueChange={(v) => setUnitTypeId(v === 'all' ? undefined : v)}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
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
          </div>

          {canWrite && (
            <BulkUnitsBar
              unitIds={[...selected].filter((id) => visibleIds.includes(id))}
              {...(facilityId ? { facilityId } : {})}
              onDone={() => setSelected(new Set())}
            />
          )}
          <DataTable
            filtersActive={!!status || !!unitTypeId || !!tableFloorId}
            onClearFilters={() => {
              setStatus(undefined);
              setUnitTypeId(undefined);
              setTableFloorId(undefined);
            }}
            rowHref={(u) => `/units/${u.id}`}
            columns={columns}
            data={units.data?.items ?? []}
            isLoading={units.isLoading}
            searchPlaceholder="Buscar por código..."
            emptyText="Aún no hay trasteros. Crea el primero con «Nuevo trastero» o impórtalos desde un Excel."
          />
        </>
      ) : (
        <PlanView
          facilityId={facilityId}
          setFacilityId={selectFacility}
          facilities={facilities.data ?? []}
          floors={floors.data ?? []}
          floorId={floorId}
          setFloorId={setFloorId}
        />
      )}

      <ChangeUnitStatusDialog unit={target} onClose={() => setTarget(null)} />
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
}: {
  facilityId: string | undefined;
  setFacilityId: (v: string | undefined) => void;
  facilities: FacilityDto[];
  floors: FacilityFloorDto[];
  floorId: string | undefined;
  setFloorId: (v: string | undefined) => void;
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
        <PlanViewer facilityId={facilityId} floorId={effectiveFloorId} />
      ) : null}
    </div>
  );
}
