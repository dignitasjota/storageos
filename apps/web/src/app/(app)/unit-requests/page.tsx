'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Check, Download, Hourglass, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { UnitRequestDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
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
import { downloadCsv } from '@/lib/csv';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { formatDate } from '@/lib/format';
import { useUnitRequestToWaitlist } from '@/lib/unit-ops/hooks';
import { useResolveUnitRequest, useUnitRequests } from '@/lib/unit-requests/hooks';

const STATUS: Record<
  UnitRequestDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  handled: { label: 'Atendida', variant: 'default' },
  rejected: { label: 'Rechazada', variant: 'outline' },
};

export default function UnitRequestsPage() {
  const ask = useConfirm();
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const list = useUnitRequests(statusFilter || undefined);
  const resolve = useResolveUnitRequest();
  const canResolve = useHasPermission('contracts:write');
  const [toQueue, setToQueue] = useState<UnitRequestDto | null>(null);

  function exportCsv() {
    downloadCsv('solicitudes-de-trastero.csv', [
      ['Fecha', 'Cliente', 'Local', 'Trastero o tamaño', 'Nota', 'Estado', 'Respuesta'],
      ...(list.data ?? []).map((r) => [
        formatDate(r.createdAt),
        r.customerName,
        r.facilityName ?? '',
        r.unitCode ?? r.unitTypeName ?? '',
        r.note,
        STATUS[r.status].label,
        r.resolutionNote ?? '',
      ]),
    ]);
  }

  async function doResolve(id: string, status: 'handled' | 'rejected') {
    const res = await ask(
      status === 'handled'
        ? {
            title: 'Marcar como atendida',
            description: 'Le avisamos por correo.',
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

  const columns: ColumnDef<UnitRequestDto>[] = [
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
      id: 'wanted',
      header: 'Trastero solicitado',
      cell: ({ row }) => {
        const r = row.original;
        const label = r.unitCode ?? r.unitTypeName ?? '—';
        return (
          <div className="text-sm">
            {r.unitId ? (
              <Link href={`/units/${r.unitId}`} className="hover:underline">
                {label}
              </Link>
            ) : (
              <span>{label}</span>
            )}
            {r.facilityName && <span className="text-muted-foreground"> · {r.facilityName}</span>}
          </div>
        );
      },
    },
    {
      accessorKey: 'note',
      header: 'Nota',
      cell: ({ row }) =>
        row.original.note ? (
          <span className="line-clamp-2 max-w-md text-sm">{row.original.note}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
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
            <Button asChild size="sm" variant="ghost">
              <Link
                href={`/contracts/new?${new URLSearchParams({
                  unitRequestId: row.original.id,
                  customerId: row.original.customerId,
                  ...(row.original.unitId ? { unitId: row.original.unitId } : {}),
                  ...(row.original.facilityId ? { facilityId: row.original.facilityId } : {}),
                  ...(row.original.unitTypeId ? { unitTypeId: row.original.unitTypeId } : {}),
                }).toString()}`}
              >
                Crear contrato
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setToQueue(row.original)}>
              <Hourglass className="mr-1 h-4 w-4" /> A la lista de espera
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => doResolve(row.original.id, 'handled')}
            >
              <Check className="mr-1 h-4 w-4" /> Atendida
            </Button>
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
        <h1 className="text-2xl font-semibold tracking-tight">Solicitudes de trastero</h1>
        <p className="text-sm text-muted-foreground">
          Inquilinos que han solicitado contratar un trastero adicional desde su portal.
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
      {toQueue && <ToWaitlistDialog request={toQueue} onClose={() => setToQueue(null)} />}
    </div>
  );
}

/** No hay hueco: lo apunta a la cola y le contesta. */
function ToWaitlistDialog({ request, onClose }: { request: UnitRequestDto; onClose: () => void }) {
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const move = useUnitRequestToWaitlist();
  const [facilityId, setFacilityId] = useState(request.facilityId ?? '');
  const [unitTypeId, setUnitTypeId] = useState(request.unitTypeId ?? '');

  async function submit() {
    try {
      await move.mutateAsync({ id: request.id, input: { facilityId, unitTypeId } });
      toast.success('Apuntado a la lista de espera y avisado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo apuntar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pasar a la lista de espera</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {request.customerName} entra en la cola y recibe un correo. La solicitud queda atendida.
          </p>
          <div className="space-y-1">
            <Label>Local</Label>
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un local" />
              </SelectTrigger>
              <SelectContent>
                {(facilities.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Tamaño</Label>
            <Select value={unitTypeId} onValueChange={setUnitTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un tamaño" />
              </SelectTrigger>
              <SelectContent>
                {(unitTypes.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!facilityId || !unitTypeId || move.isPending}
          >
            Apuntar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
