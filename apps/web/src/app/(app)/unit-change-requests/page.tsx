'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, Check, Download, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { UnitChangeRequestDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { DateSelect } from '@/components/month-year-select';
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
import { downloadCsv } from '@/lib/csv';
import { useUnits } from '@/lib/facilities/hooks';
import { formatDate, formatEur, formatNumber } from '@/lib/format';
import { useMoveFromUnitChange } from '@/lib/operations/features-hooks';
import { useResolveUnitChangeRequest, useUnitChangeRequests } from '@/lib/unit-changes/hooks';
import { useUnitAlternatives } from '@/lib/unit-ops/hooks';

const STATUS: Record<
  UnitChangeRequestDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  handled: { label: 'Atendida', variant: 'default' },
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
    const res = await ask(
      status === 'handled'
        ? {
            title: 'Marcar como atendida',
            description: 'Le avisamos por correo. Para hacer el cambio, usa «Trasladar».',
            input: { label: 'Mensaje para el inquilino (opcional)' },
            confirmLabel: 'Atendida',
          }
        : {
            title: 'Rechazar la solicitud',
            description: 'Le avisamos por correo con el motivo.',
            input: { label: 'Motivo', required: true },
            confirmLabel: 'Rechazar',
            destructive: true,
          },
    );
    if (!res) return;
    const resolutionNote = res.value.trim() || undefined;
    try {
      await resolve.mutateAsync({
        id,
        input: { status, ...(resolutionNote ? { resolutionNote } : {}) },
      });
      toast.success(status === 'handled' ? 'Solicitud atendida.' : 'Solicitud rechazada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  function exportCsv() {
    downloadCsv('cambios-de-trastero.csv', [
      [
        'Fecha',
        'Cliente',
        'Trastero actual',
        'Trastero pedido',
        'Desde',
        'Nota',
        'Estado',
        'Respuesta',
      ],
      ...(list.data ?? []).map((r) => [
        formatDate(r.createdAt),
        r.customerName,
        r.unitCode ?? '',
        r.targetUnitCode ?? '',
        r.desiredDate ? formatDate(r.desiredDate) : '',
        r.note,
        STATUS[r.status].label,
        r.resolutionNote ?? '',
      ]),
    ]);
  }

  const columns: ColumnDef<UnitChangeRequestDto>[] = [
    {
      accessorKey: 'customerName',
      header: 'Cliente',
      cell: ({ row }) => (
        <div>
          <Link
            href={`/customers/${row.original.customerId}`}
            className="font-medium hover:underline"
          >
            {row.original.customerName}
          </Link>
          <p className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</p>
        </div>
      ),
    },
    {
      id: 'unit',
      header: 'Trastero actual',
      cell: ({ row }) =>
        row.original.unitCode ? (
          row.original.contractId ? (
            <Link href={`/contracts/${row.original.contractId}`} className="hover:underline">
              {row.original.unitCode}
            </Link>
          ) : (
            <span>{row.original.unitCode}</span>
          )
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
          {row.original.status === 'pending' && row.original.targetUnitFree === false && (
            <p className="text-xs text-amber-600">Ese trastero ya no está libre.</p>
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
              <Check className="mr-1 h-4 w-4" /> Atendida
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

      <div className="flex flex-wrap gap-2">
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
        <Button
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={(list.data ?? []).length === 0}
        >
          <Download className="mr-1 size-4" /> CSV
        </Button>
      </div>

      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          isLoading={list.isLoading}
          emptyText="No hay solicitudes."
        />
      )}
      {moving && <MoveDialog request={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

/** Traslada el contrato al trastero elegido y deja la solicitud gestionada. */
function MoveDialog({ request, onClose }: { request: UnitChangeRequestDto; onClose: () => void }) {
  const units = useUnits({ status: 'available' });
  const move = useMoveFromUnitChange();
  const alternatives = useUnitAlternatives(request.id, request.targetUnitFree !== true);
  // Si el inquilino eligió trastero y sigue libre, viene ya puesto (y su precio).
  const [newUnitId, setNewUnitId] = useState(
    request.targetUnitFree ? (request.targetUnitId ?? '') : '',
  );
  const [newPrice, setNewPrice] = useState(
    request.targetUnitPrice != null ? String(request.targetUnitPrice) : '',
  );
  const [prorate, setProrate] = useState(false);
  const [date, setDate] = useState(request.desiredDate?.slice(0, 10) ?? '');

  async function submit() {
    try {
      await move.mutateAsync({
        id: request.id,
        newUnitId,
        ...(newPrice.trim() ? { newPrice: Number(newPrice) } : {}),
        ...(prorate ? { prorate: true } : {}),
        ...(date ? { effectiveDate: date } : {}),
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
          {request.targetUnitFree === false && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              El {request.targetUnitCode} que pidió ya no está libre: elige otro.
            </p>
          )}
          {(alternatives.data ?? []).length > 0 && (
            <div className="space-y-1">
              <Label>Parecidos y libres</Label>
              <div className="flex flex-wrap gap-2">
                {(alternatives.data ?? []).map((a) => (
                  <Button
                    key={a.unitId}
                    type="button"
                    size="sm"
                    variant={newUnitId === a.unitId ? 'default' : 'outline'}
                    onClick={() => {
                      setNewUnitId(a.unitId);
                      setNewPrice(String(a.priceMonthly));
                    }}
                  >
                    {a.unitCode}
                    {a.areaM2 ? ` · ${formatNumber(a.areaM2)} m²` : ''} ·{' '}
                    {formatEur(a.priceMonthly)}
                  </Button>
                ))}
              </div>
            </div>
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
          <div className="space-y-1">
            <Label>Fecha del traslado (opcional)</Label>
            <DateSelect
              years={2}
              future
              value={date || undefined}
              onChange={(v) => setDate(v ?? '')}
            />
            <p className="text-xs text-muted-foreground">
              Con una fecha futura, el trastero queda reservado y el cambio se hace ese día.
            </p>
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
