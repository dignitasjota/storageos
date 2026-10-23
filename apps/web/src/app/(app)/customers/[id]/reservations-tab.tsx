'use client';

import { type ReservationDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';

import { DataTable } from '@/components/data-table';
import { ReservationStatusBadge } from '@/components/reservation-status-badge';
import { useReservations } from '@/lib/customers/hooks';
import { formatDate, formatEur } from '@/lib/format';

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
      cell: ({ row }) => formatDate(row.original.validFrom),
    },
    {
      accessorKey: 'validUntil',
      header: 'Hasta',
      cell: ({ row }) => formatDate(row.original.validUntil),
    },
    {
      accessorKey: 'depositAmount',
      header: 'Fianza',
      cell: ({ row }) => formatEur(row.original.depositAmount),
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
