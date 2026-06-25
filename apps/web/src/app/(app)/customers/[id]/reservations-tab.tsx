'use client';

import { type ReservationDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';

import { DataTable } from '@/components/data-table';
import { ReservationStatusBadge } from '@/components/reservation-status-badge';
import { useReservations } from '@/lib/customers/hooks';

export function CustomerReservationsTab({ customerId }: { customerId: string }) {
  const reservations = useReservations({ customerId });

  const columns: ColumnDef<ReservationDto>[] = [
    {
      accessorKey: 'unitCode',
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
  ];

  return (
    <DataTable
      columns={columns}
      data={reservations.data ?? []}
      isLoading={reservations.isLoading}
      emptyText="Este inquilino aún no tiene reservas."
    />
  );
}
