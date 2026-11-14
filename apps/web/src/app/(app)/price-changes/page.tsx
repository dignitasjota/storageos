'use client';

import { PRICE_CHANGE_SOURCE_LABELS, type PriceChangeRowDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import { usePriceChanges } from '@/lib/portfolio/hooks';
import { useRentIncreaseItemAction } from '@/lib/rent-increases/hooks';

const SOURCE_VARIANT: Record<PriceChangeRowDto['source'], 'default' | 'secondary' | 'outline'> = {
  scheduled: 'secondary',
  rent_increase: 'default',
  anniversary: 'outline',
};

/**
 * Todos los cambios de cuota previstos en un sitio: los programados en la
 * ficha de cada contrato, las subidas de precio y las actualizaciones anuales
 * por revisar.
 */
export default function PriceChangesPage() {
  const ask = useConfirm();
  const facilityId = useHeaderFacilityId();
  const list = usePriceChanges(facilityId);
  const remove = useRentIncreaseItemAction();
  const canManage = useHasPermission('contracts:manage');
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const decided = rows.filter((r) => r.source !== 'anniversary');
  const monthly = decided.reduce((s, r) => s + (r.newPrice - r.currentPrice), 0);

  async function removeFromBatch(r: PriceChangeRowDto) {
    if (!r.rentIncreaseId || !r.rentIncreaseItemId) return;
    if (
      !(await ask({
        title: `¿Quitar a ${r.customerName} de la subida «${r.rentIncreaseName}»?`,
        description: r.notified
          ? 'Su cuota no cambiará y le llega un correo diciendo que la subida queda anulada.'
          : 'Su cuota no cambiará.',
        confirmLabel: 'Quitar',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync({
        id: r.rentIncreaseId,
        itemId: r.rentIncreaseItemId,
        action: 'remove',
      });
      toast.success('Quitado de la subida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  function exportCsv() {
    downloadCsv('cuotas-previstas.csv', [
      [
        'Fecha',
        'Contrato',
        'Inquilino',
        'Trastero',
        'Local',
        'Cuota actual',
        'Cuota nueva',
        'Origen',
      ],
      ...rows.map((r) => [
        formatDate(r.date),
        r.contractNumber,
        r.customerName,
        r.unitCode,
        r.facilityName,
        r.currentPrice,
        r.newPrice,
        r.source === 'rent_increase'
          ? `Subida «${r.rentIncreaseName ?? ''}»`
          : PRICE_CHANGE_SOURCE_LABELS[r.source],
      ]),
    ]);
  }

  const columns: ColumnDef<PriceChangeRowDto>[] = [
    {
      id: 'date',
      header: 'Desde',
      accessorFn: (r) => r.date,
      cell: ({ row }) => <span className="whitespace-nowrap">{formatDate(row.original.date)}</span>,
    },
    {
      id: 'customer',
      header: 'Inquilino',
      accessorFn: (r) => `${r.customerName} ${r.contractNumber}`,
      cell: ({ row }) => (
        <div>
          <Link
            href={`/customers/${row.original.customerId}`}
            className="font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.customerName}
          </Link>
          <p className="text-xs text-muted-foreground">{row.original.contractNumber}</p>
        </div>
      ),
    },
    {
      id: 'unit',
      header: 'Trastero',
      accessorFn: (r) => `${r.unitCode} ${r.facilityName}`,
      cell: ({ row }) => `${row.original.unitCode} · ${row.original.facilityName}`,
    },
    {
      id: 'change',
      header: 'Cuota',
      accessorFn: (r) => r.newPrice - r.currentPrice,
      cell: ({ row }) => {
        const d = row.original.newPrice - row.original.currentPrice;
        return (
          <span className="whitespace-nowrap">
            {formatEur(row.original.currentPrice)} →{' '}
            <strong>{formatEur(row.original.newPrice)}</strong>{' '}
            <span
              className={`text-xs ${d >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
            >
              ({d >= 0 ? '+' : ''}
              {formatEur(d)})
            </span>
          </span>
        );
      },
    },
    {
      id: 'source',
      header: 'Origen',
      accessorFn: (r) => r.source,
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={SOURCE_VARIANT[row.original.source]}>
            {row.original.source === 'rent_increase'
              ? `Subida «${row.original.rentIncreaseName ?? ''}»`
              : PRICE_CHANGE_SOURCE_LABELS[row.original.source]}
          </Badge>
          {row.original.source === 'rent_increase' && !row.original.notified && (
            <Badge variant="outline">Sin avisar</Badge>
          )}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      meta: { mobileLabel: '' },
      cell: ({ row }) =>
        canManage && row.original.source === 'rent_increase' ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void removeFromBatch(row.original)}
              disabled={remove.isPending}
            >
              Quitar de la subida
            </Button>
          </div>
        ) : row.original.source === 'anniversary' ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="ghost" asChild>
              <Link href="/renewals">Revisar</Link>
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cuotas previstas</h1>
        <p className="text-sm text-muted-foreground">
          Todos los cambios de cuota que vienen: los programados en cada contrato, las subidas de
          precio y las actualizaciones anuales que faltan por revisar.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Cambios decididos</p>
            <p className="text-2xl font-semibold">{decided.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Más al mes cuando se apliquen</p>
            <p className="text-2xl font-semibold text-emerald-700 dark:text-emerald-400">
              {monthly >= 0 ? '+' : ''}
              {formatEur(monthly)}
            </p>
            <p className="text-xs text-muted-foreground">Sin IVA</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Actualizaciones anuales por revisar</p>
            <p className="text-2xl font-semibold">{rows.length - decided.length}</p>
          </CardContent>
        </Card>
      </div>
      {list.isError ? (
        <Card>
          <SectionError onRetry={() => void list.refetch()} />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={list.isLoading}
          rowHref={(r) => `/contracts/${r.contractId}?tab=billing`}
          searchPlaceholder="Buscar inquilino, contrato o trastero..."
          emptyText="No hay ningún cambio de cuota previsto."
          toolbarRight={
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          }
        />
      )}
    </div>
  );
}
