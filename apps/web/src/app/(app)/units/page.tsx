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
import { toast } from 'sonner';

import { InventoryIssuesBanner } from './inventory-issues-banner';

import { Can } from '@/components/auth/can';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useChangeUnitStatus,
  useFacilities,
  useFloors,
  useOccupancyDashboard,
  useUnits,
  useUnitTypes,
} from '@/lib/facilities/hooks';
import { useFacilityStore } from '@/lib/facilities/store';

// Konva no funciona en SSR; el plano se carga solo en cliente.
const PlanViewer = dynamic(() => import('./plan-viewer').then((m) => m.PlanViewer), {
  ssr: false,
});

const STATUS_OPTIONS: UnitStatusValue[] = ['available', 'reserved', 'maintenance', 'blocked'];

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
      setCurrentFacility(id ?? null);
    },
    [setCurrentFacility],
  );
  const [status, setStatus] = useState<UnitStatusValue | undefined>();
  const [unitTypeId, setUnitTypeId] = useState<string | undefined>();
  const [view, setView] = useState<'table' | 'plan'>('table');
  const [floorId, setFloorId] = useState<string | undefined>();

  const facilities = useFacilities();
  const types = useUnitTypes();
  const occupancy = useOccupancyDashboard();
  const floors = useFloors(view === 'plan' ? facilityId : undefined);

  // Si solo hay un local, lo selecciona automáticamente (no hace falta elegirlo).
  useEffect(() => {
    if (!facilityId && facilities.data && facilities.data.length === 1) {
      selectFacility(facilities.data[0]!.id);
    }
  }, [facilities.data, facilityId, selectFacility]);

  const units = useUnits({
    ...(facilityId ? { facilityId } : {}),
    ...(status ? { status } : {}),
    ...(unitTypeId ? { unitTypeId } : {}),
  });

  const changeStatus = useChangeUnitStatus();
  const canWrite = useHasPermission('units:write');
  const [target, setTarget] = useState<UnitDto | null>(null);
  const [newStatus, setNewStatus] = useState<UnitStatusValue>('available');
  const [reason, setReason] = useState('');

  async function submitChange() {
    if (!target) return;
    try {
      await changeStatus.mutateAsync({
        id: target.id,
        input: { status: newStatus, reason: reason || undefined },
      });
      toast.success('Estado actualizado.');
      setTarget(null);
      setReason('');
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string }).code;
        if (code === 'invalid_status_transition') {
          toast.error(`Transición no permitida: ${target.status} → ${newStatus}`);
          return;
        }
        if (code === 'occupied_via_contract_only') {
          toast.error('El estado "ocupado" se asigna al firmar un contrato.');
          return;
        }
        toast.error(err.body.message);
        return;
      }
      toast.error('Error');
    }
  }

  const columns: ColumnDef<UnitDto>[] = useMemo(
    () => [
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
        cell: ({ row }) => row.original.areaM2.toFixed(2),
      },
      {
        accessorKey: 'basePriceMonthly',
        header: 'Precio',
        cell: ({ row }) => `${row.original.basePriceMonthly.toFixed(2)} €`,
      },
      {
        accessorKey: 'status',
        header: 'Estado',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canWrite && (
                <DropdownMenuItem
                  onClick={() => {
                    setTarget(row.original);
                    setNewStatus('available');
                    setReason('');
                  }}
                >
                  Cambiar estado
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link href={`/units/${row.original.id}`}>Ver historial</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [canWrite],
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
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {occupancy.data && occupancy.data.totalUnits > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {STATUS_KPIS.map((k) => {
            const count = occupancy.data.byStatus[k.status] ?? 0;
            const active = status === k.status;
            return (
              <button
                key={k.status}
                type="button"
                onClick={() => setStatus(active ? undefined : k.status)}
                className={`rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted/50 ${
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
                <span className="mt-1 block text-2xl font-semibold tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {view === 'table' ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Select
              value={facilityId ?? 'all'}
              onValueChange={(v) => selectFacility(v === 'all' ? undefined : v)}
            >
              <SelectTrigger className="w-[200px]">
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
              <SelectTrigger className="w-[200px]">
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
            <Select
              value={unitTypeId ?? 'all'}
              onValueChange={(v) => setUnitTypeId(v === 'all' ? undefined : v)}
            >
              <SelectTrigger className="w-[200px]">
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

          <DataTable
            columns={columns}
            data={units.data?.items ?? []}
            isLoading={units.isLoading}
            searchPlaceholder="Buscar por código..."
            emptyText="No hay trasteros que coincidan con los filtros."
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

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar estado del trastero {target?.code}</DialogTitle>
            <DialogDescription>
              Estado actual: {target && STATUS_LABELS[target.status]}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nuevo estado</Label>
              <Select value={newStatus} onValueChange={(v) => setNewStatus(v as UnitStatusValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Motivo (opcional)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={submitChange} disabled={changeStatus.isPending}>
              {changeStatus.isPending ? 'Guardando...' : 'Cambiar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
