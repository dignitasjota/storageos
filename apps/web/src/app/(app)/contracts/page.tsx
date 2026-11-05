'use client';

import { type ContractDto, type ContractStatusValue, type PageDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Download, Plus, Send, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

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
import { apiFetch, ApiError } from '@/lib/auth/api';
import { downloadCsv } from '@/lib/csv';
import { useBulkRequestSignature } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';

const STATUS_LABELS: Record<ContractStatusValue, string> = {
  draft: 'Borrador',
  active: 'Activo',
  ending: 'En baja',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
};

type ContractView = 'unsigned' | 'first_payment' | 'ending' | 'expiring';

const VIEWS: { key: ContractView; label: string }[] = [
  { key: 'unsigned', label: 'Pendientes de firma' },
  { key: 'first_payment', label: 'Pendientes de primer pago' },
  { key: 'ending', label: 'En baja' },
  { key: 'expiring', label: 'Vencen en 30 días' },
];

export default function ContractsPage() {
  const [view, setView] = useState<ContractView | undefined>();
  const [status, setStatus] = useState<ContractStatusValue | undefined>();
  // «Ver todo» de «Hoy» llega con el estado en la dirección.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('status');
    if (fromUrl) setStatus(fromUrl as ContractStatusValue);
  }, []);
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [facilityId, setFacilityId] = useFacilityFilterState();

  const facilities = useFacilities();
  const [searchText, search, setSearchText] = useDebouncedSearch();
  const params = { status, customerId, facilityId, view, search: search || undefined };
  const contracts = usePagedList<ContractDto>('contracts', '/contracts', params);
  const bulkSign = useBulkRequestSignature();

  async function sendSignatures() {
    const ids = contracts.rows.filter((c) => c.status === 'draft').map((c) => c.id);
    try {
      const res = await bulkSign.mutateAsync(ids.slice(0, 100));
      if (res.failed.length > 0) {
        toast.warning(
          `Enviados ${res.sent}. Sin enviar ${res.failed.length}: ${res.failed[0]?.reason}`,
        );
      } else {
        toast.success(`Enlace de firma enviado a ${res.sent}.`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
    }
  }

  /** Todo lo que cumple los filtros, no solo lo cargado (hasta 5.000 filas). */
  async function exportCsv() {
    const rows: ContractDto[] = [];
    let cursor: string | null = null;
    try {
      for (let i = 0; i < 50; i++) {
        const q = new URLSearchParams({ limit: '100' });
        for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
        if (cursor) q.set('cursor', cursor);
        const page: PageDto<ContractDto> = await apiFetch(`/contracts/page?${q.toString()}`);
        rows.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo exportar');
      return;
    }
    downloadCsv('contratos.csv', [
      ['Número', 'Inquilino', 'Local', 'Trastero', 'Inicio', 'Fin', 'Cuota', 'Pendiente', 'Estado'],
      ...rows.map((c) => [
        c.contractNumber,
        c.customerName,
        c.facilityName,
        c.unitCode,
        formatDate(c.startDate),
        c.endDate ? formatDate(c.endDate) : '',
        c.effectivePrice,
        c.pendingAmount ?? 0,
        STATUS_LABELS[c.status],
      ]),
    ]);
  }

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
      accessorKey: 'endDate',
      header: 'Fin',
      cell: ({ row }) => (row.original.endDate ? formatDate(row.original.endDate) : '—'),
    },
    {
      accessorKey: 'effectivePrice',
      header: 'Cuota',
      cell: ({ row }) => formatEur(row.original.effectivePrice),
    },
    {
      accessorKey: 'pendingAmount',
      header: 'Pendiente',
      cell: ({ row }) =>
        (row.original.pendingAmount ?? 0) > 0 ? (
          <span className="text-red-600 dark:text-red-400">
            {formatEur(row.original.pendingAmount ?? 0)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
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
            <Button variant="outline" onClick={() => void exportCsv()}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
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

      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Button
            key={v.key}
            size="sm"
            variant={view === v.key ? 'default' : 'outline'}
            onClick={() => {
              setView(view === v.key ? undefined : v.key);
              setStatus(undefined);
            }}
          >
            {v.label}
          </Button>
        ))}
        {view === 'unsigned' && contracts.rows.length > 0 && (
          <Can permission="contracts:write">
            <Button
              size="sm"
              variant="ghost"
              disabled={bulkSign.isPending}
              onClick={() => void sendSignatures()}
            >
              <Send className="mr-1 h-4 w-4" /> Enviar el enlace de firma a todos
            </Button>
          </Can>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => {
            setStatus(v === 'all' ? undefined : (v as ContractStatusValue));
            setView(undefined);
          }}
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
        filtersActive={!!status || !!customerId || !!view}
        onClearFilters={() => {
          setStatus(undefined);
          setCustomerId(undefined);
          setView(undefined);
        }}
        rowHref={(c) => `/contracts/${c.id}`}
        columns={columns}
        data={contracts.rows}
        isLoading={contracts.isLoading}
        guide="alquilar"
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
