'use client';

import { type UnitDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CreateUnitDialog } from '@/components/units/create-unit-dialog';
import { ApiError } from '@/lib/auth/api';
import { useDeleteUnit, useUnits, useUnitTypes } from '@/lib/facilities/hooks';
import { formatEur, formatNumber } from '@/lib/format';

interface Props {
  facilityId: string;
}

export function FacilityUnitsTab({ facilityId }: Props) {
  const ask = useConfirm();
  const units = useUnits({ facilityId });
  const types = useUnitTypes();
  const router = useRouter();
  const pathname = usePathname();
  const remove = useDeleteUnit();

  async function handleDelete(id: string) {
    if (!(await ask({ title: '¿Borrar este trastero?', destructive: true }))) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Trastero borrado.');
    } catch (err) {
      if (err instanceof ApiError && (err.body as { code?: string }).code === 'unit_occupied') {
        toast.error('No puedes borrar un trastero ocupado.');
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<UnitDto>[] = [
    {
      accessorKey: 'code',
      header: 'Código',
      cell: ({ row }) => (
        <Link href={`/units/${row.original.id}`} className="font-medium hover:underline">
          {row.original.code}
        </Link>
      ),
    },
    {
      accessorKey: 'unitTypeName',
      header: 'Tipo',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span
            className="inline-block size-3 rounded-sm border"
            style={{ backgroundColor: row.original.unitTypeColor }}
          />
          {row.original.unitTypeName}
        </div>
      ),
    },
    {
      accessorKey: 'floorName',
      header: 'Planta',
    },
    {
      accessorKey: 'areaM2',
      header: 'm²',
      cell: ({ row }) => formatNumber(row.original.areaM2),
    },
    {
      accessorKey: 'basePriceMonthly',
      header: 'Precio (sin IVA)',
      cell: ({ row }) => formatEur(row.original.basePriceMonthly),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Acciones">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => handleDelete(row.original.id)}
            >
              Borrar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const activeTypes = (types.data ?? []).filter((t) => t.isActive);

  return (
    <DataTable
      rowHref={(u) => `/units/${u.id}`}
      columns={columns}
      data={units.data?.items ?? []}
      isLoading={units.isLoading}
      searchPlaceholder="Buscar por código..."
      toolbarRight={
        <CreateUnitDialog
          facilityId={facilityId}
          onGoToTypes={() => router.replace(`${pathname}?tab=unit-types`, { scroll: false })}
        />
      }
      emptyText={
        activeTypes.length === 0
          ? 'Antes de crear trasteros, define al menos un tipo en la pestaña "Tipos".'
          : 'Aún no has creado ningún trastero en este local.'
      }
    />
  );
}
