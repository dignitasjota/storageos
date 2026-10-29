'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, Check, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { UnitChangeRequestDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useUnits } from '@/lib/facilities/hooks';
import { formatDate, formatEur, formatNumber } from '@/lib/format';
import { useMoveFromUnitChange } from '@/lib/operations/features-hooks';
import { useResolveUnitChangeRequest, useUnitChangeRequests } from '@/lib/unit-changes/hooks';

const STATUS: Record<
  UnitChangeRequestDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  handled: { label: 'Gestionada', variant: 'default' },
  rejected: { label: 'Rechazada', variant: 'outline' },
};

export default function UnitChangeRequestsPage() {
  const ask = useConfirm();
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const list = useUnitChangeRequests(statusFilter || undefined);
  const resolve = useResolveUnitChangeRequest();
  const canResolve = useHasPermission('contracts:write');
  const canMove = useHasPermission('contracts:manage');
  const [moving, setMoving] = useState<UnitChangeRequestDto | null>(null);

  async function doResolve(id: string, status: 'handled' | 'rejected') {
    let resolutionNote: string | undefined;
    if (status === 'handled') {
      const res = await ask({
        title: 'Marcar como gestionada',
        input: { label: 'Nota de resolución (opcional)' },
        confirmLabel: 'Gestionada',
      });
      if (!res) return;
      resolutionNote = res.value || undefined;
    }
    try {
      await resolve.mutateAsync({
        id,
        input: { status, ...(resolutionNote ? { resolutionNote } : {}) },
      });
      toast.success(status === 'handled' ? 'Solicitud gestionada.' : 'Solicitud rechazada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<UnitChangeRequestDto>[] = [
    {
      accessorKey: 'customerName',
      header: 'Cliente',
      cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span>,
    },
    {
      id: 'unit',
      header: 'Trastero actual',
      cell: ({ row }) =>
        row.original.unitCode ? (
          <span>{row.original.unitCode}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'note',
      header: 'Solicitud',
      cell: ({ row }) => (
        <div className="max-w-md space-y-0.5 text-sm">
          {row.original.targetUnitCode && (
            <p className="font-medium">
              Quiere el {row.original.targetUnitCode}
              {row.original.desiredDate ? ` desde el ${formatDate(row.original.desiredDate)}` : ''}
              {row.original.targetUnitPrice != null && row.original.currentPrice != null
                ? ` (${formatEur(row.original.targetUnitPrice)} frente a ${formatEur(row.original.currentPrice)} sin IVA)`
                : ''}
            </p>
          )}
          {row.original.note && <p className="line-clamp-2">{row.original.note}</p>}
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS[row.original.status];
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canResolve && row.original.status === 'pending' ? (
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => doResolve(row.original.id, 'handled')}
            >
              <Check className="mr-1 h-4 w-4" /> Gestionar
            </Button>
            {row.original.contractId && canMove && (
              <Button variant="ghost" size="sm" onClick={() => setMoving(row.original)}>
                <ArrowRightLeft className="mr-1 h-4 w-4" /> Trasladar
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => doResolve(row.original.id, 'rejected')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : row.original.resolutionNote ? (
          <span className="text-xs text-muted-foreground">{row.original.resolutionNote}</span>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cambios de trastero</h1>
        <p className="text-sm text-muted-foreground">
          Solicitudes de cambio o ampliación de trastero enviadas por los inquilinos desde su
          portal.
        </p>
      </div>

      <div className="flex gap-2">
        {(['pending', 'handled', 'rejected', ''] as const).map((s) => (
          <Button
            key={s || 'all'}
            variant={statusFilter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s === '' ? 'Todas' : STATUS[s].label}
          </Button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={list.data ?? []}
        isLoading={list.isLoading}
        emptyText="No hay solicitudes."
      />
      {moving && <MoveDialog request={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

/** Traslada el contrato al trastero elegido y deja la solicitud gestionada. */
function MoveDialog({ request, onClose }: { request: UnitChangeRequestDto; onClose: () => void }) {
  const units = useUnits({ status: 'available' });
  const move = useMoveFromUnitChange();
  // Si el inquilino eligió trastero, viene ya puesto (y su precio).
  const [newUnitId, setNewUnitId] = useState(request.targetUnitId ?? '');
  const [newPrice, setNewPrice] = useState(
    request.targetUnitPrice != null ? String(request.targetUnitPrice) : '',
  );
  const [prorate, setProrate] = useState(false);

  async function submit() {
    try {
      await move.mutateAsync({
        id: request.id,
        newUnitId,
        ...(newPrice.trim() ? { newPrice: Number(newPrice) } : {}),
        ...(prorate ? { prorate: true } : {}),
      });
      toast.success('Contrato trasladado y solicitud gestionada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo trasladar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trasladar a {request.customerName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {request.note && <p className="rounded-md bg-muted px-3 py-2 text-sm">{request.note}</p>}
          {request.desiredDate && (
            <p className="text-sm text-muted-foreground">
              Lo quiere desde el {formatDate(request.desiredDate)}.
            </p>
          )}
          <div className="space-y-1">
            <Label>Nuevo trastero (disponible)</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
              value={newUnitId}
              onChange={(e) => setNewUnitId(e.target.value)}
            >
              <option value="">Elige un trastero…</option>
              {(units.data?.items ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {u.facilityName}
                  {u.areaM2 ? ` · ${formatNumber(u.areaM2)} m²` : ''} (
                  {formatEur(u.basePriceMonthly)}
                  /mes)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Nueva cuota (€, opcional)</Label>
            <Input
              type="number"
              step="0.01"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              placeholder="Vacío: se mantiene la actual"
            />
          </div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={prorate}
              onChange={(e) => setProrate(e.target.checked)}
            />
            <span>Cobrar la diferencia de los días que quedan del mes si la cuota sube.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!newUnitId || move.isPending}>
            Trasladar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
