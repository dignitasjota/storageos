'use client';

import { type ContractDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';

import { ContractStatusBadge } from '@/components/contract-status-badge';
import { DataTable } from '@/components/data-table';
import { useContracts } from '@/lib/customers/hooks';
import { formatDate, formatEur } from '@/lib/format';

export function CustomerContractsTab({ customerId }: { customerId: string }) {
  const contracts = useContracts({ customerId });

  const columns: ColumnDef<ContractDto>[] = [
    {
      accessorKey: 'contractNumber',
      header: 'Número',
      cell: ({ row }) => (
        <Link href={`/contracts/${row.original.id}`} className="font-mono text-xs hover:underline">
          {row.original.contractNumber}
        </Link>
      ),
    },
    {
      accessorKey: 'unitCode',
      header: 'Trastero',
      cell: ({ row }) => (
        <Link href={`/units/${row.original.unitId}`} className="hover:underline">
          {row.original.facilityName} · {row.original.unitCode}
        </Link>
      ),
    },
    {
      accessorKey: 'startDate',
      header: 'Inicio',
      cell: ({ row }) => formatDate(row.original.startDate),
    },
    {
      accessorKey: 'effectivePrice',
      header: 'Cuota',
      cell: ({ row }) => formatEur(row.original.effectivePrice),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <ContractStatusBadge status={row.original.status} />,
    },
  ];

  return (
    <DataTable
      rowHref={(c) => `/contracts/${c.id}`}
      columns={columns}
      data={contracts.data ?? []}
      isLoading={contracts.isLoading}
      emptyText="Este inquilino aún no tiene contratos."
    />
  );
}
