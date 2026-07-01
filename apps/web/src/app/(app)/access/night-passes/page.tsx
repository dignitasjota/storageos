'use client';

import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';

import type { NightPassStaffDto } from '@storageos/shared';

import { DataTable } from '@/components/data-table';
import { Card, CardContent } from '@/components/ui/card';
import { useNightPasses } from '@/lib/access/hooks';

const STATUS: Record<NightPassStaffDto['status'], { label: string; className: string }> = {
  active: {
    label: 'Sin usar',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  used: {
    label: 'Utilizado',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  expired: { label: 'Caducado', className: 'bg-slate-300 text-slate-800' },
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

export default function NightPassesPage() {
  const { data, isLoading } = useNightPasses();

  const columns: ColumnDef<NightPassStaffDto>[] = [
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) => (
        <Link
          href={`/customers/${row.original.customerId}`}
          className="font-medium hover:underline"
        >
          {row.original.customerName}
        </Link>
      ),
    },
    {
      accessorKey: 'createdAt',
      header: 'Comprado',
      cell: ({ row }) => (
        <span className="text-sm">
          {new Date(row.original.createdAt).toLocaleString('es-ES', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      ),
    },
    {
      accessorKey: 'expiresAt',
      header: 'Caduca',
      cell: ({ row }) =>
        row.original.expiresAt ? (
          <span className="text-sm text-muted-foreground">
            {new Date(row.original.expiresAt).toLocaleString('es-ES', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS[row.original.status];
        return (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
          >
            {s.label}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pases nocturnos comprados por los inquilinos desde su portal (código de un solo uso que
        salta el toque de queda y caduca a la mañana siguiente).
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total" value={data?.total ?? 0} />
        <Stat label="Sin usar" value={data?.active ?? 0} />
        <Stat label="Utilizados" value={data?.used ?? 0} />
        <Stat label="Caducados" value={data?.expired ?? 0} />
        <Stat
          label="Ingresos"
          value={(data?.revenue ?? 0).toLocaleString('es-ES', {
            style: 'currency',
            currency: 'EUR',
          })}
        />
      </div>

      <DataTable
        columns={columns}
        data={data?.passes ?? []}
        isLoading={isLoading}
        emptyText="Todavía no se ha comprado ningún pase nocturno."
      />
    </div>
  );
}
