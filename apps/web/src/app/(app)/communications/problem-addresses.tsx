'use client';

import { type ProblemAddressDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';

import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { useProblemAddresses } from '@/lib/communications/hooks';
import { formatDate } from '@/lib/format';

/**
 * Inquilinos y contactos a los que no les llegan los correos: la dirección no
 * existe, la bloquea su proveedor o marcaron un correo como spam. Conviene
 * pedirles otra dirección (o llamarles).
 */
export function ProblemAddresses({ enabled }: { enabled: boolean }) {
  const list = useProblemAddresses(enabled);
  const columns: ColumnDef<ProblemAddressDto>[] = [
    {
      id: 'who',
      header: 'Quién',
      cell: ({ row }) => {
        const p = row.original;
        if (p.customerId) {
          return (
            <Link href={`/customers/${p.customerId}`} className="font-medium hover:underline">
              {p.customerName ?? p.email}
            </Link>
          );
        }
        if (p.leadId) {
          return (
            <Link href={`/leads?lead=${p.leadId}`} className="font-medium hover:underline">
              {p.leadName ?? p.email}
              <span className="ml-1 text-xs font-normal text-muted-foreground">(contacto)</span>
            </Link>
          );
        }
        return p.email;
      },
    },
    { accessorKey: 'email', header: 'Dirección' },
    {
      accessorKey: 'label',
      header: 'Qué pasa',
      cell: ({ row }) => (
        <div className="space-y-0.5">
          <Badge variant={row.original.reason === 'complaint' ? 'outline' : 'destructive'}>
            {row.original.label}
          </Badge>
          {row.original.detail && (
            <p
              className="max-w-[260px] truncate text-xs text-muted-foreground"
              title={row.original.detail}
            >
              {row.original.detail}
            </p>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'since',
      header: 'Desde',
      cell: ({ row }) => formatDate(row.original.since),
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A estas direcciones no les llegan los correos (o pidieron no recibir ofertas al marcarlos
        como spam). Las facturas y avisos tampoco les llegan: pídeles otra dirección o llámales.
      </p>
      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          isLoading={list.isLoading}
          searchPlaceholder="Buscar dirección o nombre..."
          emptyText="Todas las direcciones funcionan."
          searchText={(p) => `${p.email} ${p.customerName ?? ''} ${p.leadName ?? ''}`}
        />
      )}
    </div>
  );
}
