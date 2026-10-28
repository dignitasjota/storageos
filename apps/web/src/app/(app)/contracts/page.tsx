'use client';

import { type ContractDto, type ContractStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { contractStartLabel } from './[id]/pre-opening-card';

import { Can } from '@/components/auth/can';
import { ContractStatusBadge } from '@/components/contract-status-badge';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatEur } from '@/lib/format';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';

const STATUS_LABELS: Record<ContractStatusValue, string> = {
  draft: 'Borrador',
  active: 'Activo',
  ending: 'En baja',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
};

export default function ContractsPage() {
  const [status, setStatus] = useState<ContractStatusValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [facilityId, setFacilityId] = useFacilityFilterState();

  const facilities = useFacilities();
  const [searchText, search, setSearchText] = useDebouncedSearch();
  const contracts = usePagedList<ContractDto>('contracts', '/contracts', {
    status,
    customerId,
    facilityId,
    search: search || undefined,
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
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) => (
        <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
          {row.original.customerName}
        </Link>
      ),
    },
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
      accessorKey: 'startDate',
      header: 'Inicio',
      cell: ({ row }) => contractStartLabel(row.original),
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
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contratos</h1>
          <p className="text-sm text-muted-foreground">
            Alquileres en curso, finalizados y borradores pendientes de firma.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <>
            <Can permission="imports:manage">
              <Button asChild variant="outline">
                <Link href="/contracts/import">
                  <Upload className="mr-1 h-4 w-4" /> Importar
                </Link>
              </Button>
            </Can>
            <Can permission="contracts:write">
              <Button asChild>
                <Link href="/contracts/new">
                  <Plus className="mr-1 h-4 w-4" /> Nuevo contrato
                </Link>
              </Button>
            </Can>
          </>
        </div>
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
        <CustomerSearchSelect
          value={customerId}
          onChange={setCustomerId}
          clearLabel="Todos los inquilinos"
          className="w-[220px]"
        />
      </div>

      <DataTable
        filtersActive={!!status || !!customerId}
        onClearFilters={() => {
          setStatus(undefined);
          setCustomerId(undefined);
        }}
        rowHref={(c) => `/contracts/${c.id}`}
        columns={columns}
        data={contracts.rows}
        isLoading={contracts.isLoading}
        emptyText="Aún no hay contratos. Crea el primero con «Nuevo contrato»."
        serverSearch={{
          value: searchText,
          onChange: setSearchText,
          placeholder: 'Buscar por número, inquilino o trastero…',
        }}
        loadMore={contracts.loadMore}
      />
    </div>
  );
}
