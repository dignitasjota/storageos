'use client';

import { type ReservationDto, type ReservationStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
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
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCancelReservation,
  useConfirmReservation,
  useConvertReservation,
  useReservations,
} from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import { useReservationDepositInvoice } from '@/lib/operations/features-hooks';

const STATUS_LABELS: Record<ReservationStatusValue, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  expired: 'Caducada',
  converted: 'Convertida',
  cancelled: 'Cancelada',
};

export default function ReservationsPage() {
  const [status, setStatus] = useState<ReservationStatusValue | undefined>();
  const [facilityId, setFacilityId] = useFacilityFilterState();

  const facilities = useFacilities();
  const reservations = useReservations({
    ...(status ? { status } : {}),
    ...(facilityId ? { facilityId } : {}),
  });

  const confirm = useConfirmReservation();
  const depositInvoice = useReservationDepositInvoice();
  const canInvoice = useHasPermission('invoices:manage');
  const cancel = useCancelReservation();
  const convert = useConvertReservation();
  const canWrite = useHasPermission('reservations:write');

  const [target, setTarget] = useState<ReservationDto | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [price, setPrice] = useState(0);
  const [deposit, setDeposit] = useState(0);
  const [startDate, setStartDate] = useState(localDateString());
  const [cancelTarget, setCancelTarget] = useState<ReservationDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const columns: ColumnDef<ReservationDto>[] = [
    {
      id: 'unit',
      header: 'Trastero',
      cell: ({ row }) => (
        <span className="text-sm">
          <Link href={`/facilities/${row.original.facilityId}`} className="hover:underline">
            {row.original.facilityName}
          </Link>{' '}
          ·{' '}
          <Link href={`/units/${row.original.unitId}`} className="hover:underline">
            {row.original.unitCode}
          </Link>
        </span>
      ),
    },
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) =>
        row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
            {row.original.customerName}
          </Link>
        ) : (
          (row.original.customerName ?? '—')
        ),
    },
    {
      accessorKey: 'validFrom',
      header: 'Desde',
      cell: ({ row }) => formatDate(row.original.validFrom),
    },
    {
      accessorKey: 'validUntil',
      header: 'Hasta',
      cell: ({ row }) => formatDate(row.original.validUntil),
    },
    {
      accessorKey: 'depositAmount',
      header: 'Señal',
      cell: ({ row }) => {
        const r = row.original;
        if (r.depositAmount <= 0) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="text-sm">
            {formatEur(r.depositAmount)}{' '}
            {r.depositPaid ? (
              <span className="text-xs text-emerald-600">cobrada</span>
            ) : r.depositInvoiceId ? (
              <Link href={`/invoices/${r.depositInvoiceId}`} className="text-xs underline">
                por cobrar
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">sin factura</span>
            )}
          </span>
        );
      },
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
        if (!canWrite) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
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
              {(r.status === 'pending' || r.status === 'confirmed') &&
                r.depositAmount > 0 &&
                !r.depositInvoiceId &&
                r.customerId &&
                canInvoice && (
                  <DropdownMenuItem
                    onClick={() =>
                      depositInvoice.mutateAsync(r.id).then(
                        () => toast.success('Factura de la señal emitida.'),
                        (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                      )
                    }
                  >
                    Facturar la señal
                  </DropdownMenuItem>
                )}
              {(r.status === 'pending' || r.status === 'confirmed') && (
                <DropdownMenuItem
                  onClick={() => {
                    setTarget(r);
                    setPrice(r.unitPriceMonthly);
                    // La señal se descuenta del alquiler: no es la fianza del contrato.
                    setDeposit(r.depositInvoiceId ? 0 : r.depositAmount);
                    setStartDate(localDateString(new Date(r.validFrom)));
                    setConvertOpen(true);
                  }}
                >
                  Convertir en contrato
                </DropdownMenuItem>
              )}
              {(r.status === 'pending' || r.status === 'confirmed') && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => {
                    setCancelTarget(r);
                    setCancelReason('');
                  }}
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
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
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

      <Dialog open={!!cancelTarget} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar la reserva</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {cancelTarget?.customerName ?? 'Sin inquilino'} · {cancelTarget?.unitCode}. Si el
            trastero estaba retenido para esta reserva, vuelve a estar disponible.
          </p>
          <div>
            <Label htmlFor="cancel-reason">Motivo</Label>
            <Input
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Ej.: ya no lo necesita"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              Volver
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() =>
                cancelTarget &&
                cancel
                  .mutateAsync({
                    id: cancelTarget.id,
                    input: { reason: cancelReason.trim() || 'Cancelada por el equipo' },
                  })
                  .then(
                    () => {
                      toast.success('Reserva cancelada.');
                      setCancelTarget(null);
                    },
                    (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                  )
              }
            >
              Cancelar la reserva
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convertir reserva en contrato</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {target && target.depositAmount > 0 && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {target.depositPaid
                  ? `La señal de ${formatEur(target.depositAmount)} ya cobrada se descontará del alquiler de la primera factura.`
                  : 'La señal aún no está cobrada: si se cobra después, no se descontará sola.'}
              </p>
            )}
            <div>
              <Label>Fecha de inicio</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>Cuota mensual sin IVA (€)</Label>
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
