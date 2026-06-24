'use client';

import { type UnitDto, type UnitStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
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
  useOccupancyDashboard,
  useUnits,
  useUnitTypes,
} from '@/lib/facilities/hooks';
import { useFacilityStore } from '@/lib/facilities/store';

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
  const [facilityId, setFacilityId] = useState<string | undefined>(switcherFacility ?? undefined);
  const [status, setStatus] = useState<UnitStatusValue | undefined>();
  const [unitTypeId, setUnitTypeId] = useState<string | undefined>();

  const facilities = useFacilities();
  const types = useUnitTypes();
  const occupancy = useOccupancyDashboard();
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
              <Button variant="ghost" size="icon">
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trasteros</h1>
          <p className="text-sm text-muted-foreground">
            Vista global de todos tus trasteros con filtros.
          </p>
        </div>
        <Can permission="imports:manage">
          <Button asChild variant="outline">
            <Link href="/units/import">
              <Upload className="mr-1 h-4 w-4" /> Importar
            </Link>
          </Button>
        </Can>
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

      <div className="flex flex-wrap gap-2">
        <Select
          value={facilityId ?? 'all'}
          onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
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
              ['available', 'occupied', 'reserved', 'maintenance', 'blocked'] as UnitStatusValue[]
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
