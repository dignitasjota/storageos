'use client';

import { type ReservationDto, type ReservationStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import { ReservationStatusBadge } from '@/components/reservation-status-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import {
  useCancelReservation,
  useConfirmReservation,
  useConvertReservation,
  useReservations,
} from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityStore } from '@/lib/facilities/store';

const STATUS_LABELS: Record<ReservationStatusValue, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  expired: 'Caducada',
  converted: 'Convertida',
  cancelled: 'Cancelada',
};

export default function ReservationsPage() {
  const switcherFacility = useFacilityStore((s) => s.currentFacilityId);
  const [status, setStatus] = useState<ReservationStatusValue | undefined>();
  const [facilityId, setFacilityId] = useState<string | undefined>(switcherFacility ?? undefined);

  const facilities = useFacilities();
  const reservations = useReservations({
    ...(status ? { status } : {}),
    ...(facilityId ? { facilityId } : {}),
  });

  const confirm = useConfirmReservation();
  const cancel = useCancelReservation();
  const convert = useConvertReservation();

  const [target, setTarget] = useState<ReservationDto | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [price, setPrice] = useState(0);
  const [deposit, setDeposit] = useState(0);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));

  const columns: ColumnDef<ReservationDto>[] = [
    {
      id: 'unit',
      header: 'Trastero',
      cell: ({ row }) => `${row.original.facilityName} · ${row.original.unitCode}`,
    },
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) => row.original.customerName ?? '—',
    },
    {
      accessorKey: 'validFrom',
      header: 'Desde',
      cell: ({ row }) => new Date(row.original.validFrom).toLocaleDateString('es-ES'),
    },
    {
      accessorKey: 'validUntil',
      header: 'Hasta',
      cell: ({ row }) => new Date(row.original.validUntil).toLocaleDateString('es-ES'),
    },
    {
      accessorKey: 'depositAmount',
      header: 'Fianza',
      cell: ({ row }) => `${row.original.depositAmount.toFixed(2)} €`,
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <ReservationStatusBadge status={row.original.status} />,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {r.status === 'pending' && (
                <DropdownMenuItem
                  onClick={() =>
                    confirm.mutateAsync(r.id).then(
                      () => toast.success('Reserva confirmada.'),
                      (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                    )
                  }
                >
                  Confirmar
                </DropdownMenuItem>
              )}
              {(r.status === 'pending' || r.status === 'confirmed') && (
                <DropdownMenuItem
                  onClick={() => {
                    setTarget(r);
                    setPrice(0);
                    setDeposit(r.depositAmount);
                    setStartDate(new Date(r.validFrom).toISOString().slice(0, 10));
                    setConvertOpen(true);
                  }}
                >
                  Convertir en contrato
                </DropdownMenuItem>
              )}
              {(r.status === 'pending' || r.status === 'confirmed') && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() =>
                    cancel.mutateAsync({ id: r.id, input: { reason: 'manual' } }).then(
                      () => toast.success('Reserva cancelada.'),
                      (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                    )
                  }
                >
                  Cancelar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reservas</h1>
        <p className="text-sm text-muted-foreground">
          Pre-bloqueos de trastero antes de la firma del contrato.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as ReservationStatusValue))}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as ReservationStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      </div>

      <DataTable
        columns={columns}
        data={reservations.data ?? []}
        isLoading={reservations.isLoading}
        emptyText={
          'Aún no hay reservas. Crea una desde un trastero disponible en el plano o en /units.'
        }
      />

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convertir reserva en contrato</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Fecha de inicio</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>Cuota mensual (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Fianza (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={deposit}
                onChange={(e) => setDeposit(Number(e.target.value))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                target &&
                convert
                  .mutateAsync({
                    id: target.id,
                    input: {
                      startDate,
                      priceMonthly: price,
                      discountAmount: 0,
                      depositAmount: deposit,
                      billingCycle: 'monthly',
                    },
                  })
                  .then(
                    () => {
                      toast.success('Contrato creado en borrador.');
                      setConvertOpen(false);
                    },
                    (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                  )
              }
              disabled={price <= 0}
            >
              Crear borrador
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
