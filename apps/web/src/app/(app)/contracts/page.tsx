'use client';

import { type ContractDto, type ContractStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { ContractStatusBadge } from '@/components/contract-status-badge';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useContracts, useCustomers } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityStore } from '@/lib/facilities/store';

const STATUS_LABELS: Record<ContractStatusValue, string> = {
  draft: 'Borrador',
  active: 'Activo',
  ending: 'En baja',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
};

export default function ContractsPage() {
  const switcherFacility = useFacilityStore((s) => s.currentFacilityId);
  const [status, setStatus] = useState<ContractStatusValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [facilityId, setFacilityId] = useState<string | undefined>(switcherFacility ?? undefined);

  const facilities = useFacilities();
  const customers = useCustomers();
  const contracts = useContracts({
    ...(status ? { status } : {}),
    ...(customerId ? { customerId } : {}),
    ...(facilityId ? { facilityId } : {}),
  });

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
    { accessorKey: 'customerName', header: 'Inquilino' },
    {
      id: 'unit',
      header: 'Trastero',
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.facilityName} · {row.original.unitCode}
        </span>
      ),
    },
    {
      accessorKey: 'startDate',
      header: 'Inicio',
      cell: ({ row }) => new Date(row.original.startDate).toLocaleDateString('es-ES'),
    },
    {
      accessorKey: 'effectivePrice',
      header: 'Cuota',
      cell: ({ row }) => `${row.original.effectivePrice.toFixed(2)} €`,
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <ContractStatusBadge status={row.original.status} />,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contratos</h1>
        <p className="text-sm text-muted-foreground">
          Alquileres en curso, finalizados y borradores pendientes de firma.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as ContractStatusValue))}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as ContractStatusValue[]).map((s) => (
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
        <Select
          value={customerId ?? 'all'}
          onValueChange={(v) => setCustomerId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Inquilino" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los inquilinos</SelectItem>
            {(customers.data ?? []).slice(0, 50).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={contracts.data ?? []}
        isLoading={contracts.isLoading}
        searchPlaceholder="Buscar..."
        toolbarRight={
          <Button asChild>
            <Link href="/contracts/new">
              <Plus className="mr-1 h-4 w-4" /> Nuevo contrato
            </Link>
          </Button>
        }
        emptyText="No hay contratos que coincidan con los filtros."
      />
    </div>
  );
}
