'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CreateUnitInput, CreateUnitSchema, type UnitDto } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useCreateUnit, useDeleteUnit, useUnits, useUnitTypes } from '@/lib/facilities/hooks';

interface Props {
  facilityId: string;
}

export function FacilityUnitsTab({ facilityId }: Props) {
  const units = useUnits({ facilityId });
  const types = useUnitTypes();
  const [open, setOpen] = useState(false);
  const create = useCreateUnit();
  const remove = useDeleteUnit();

  const form = useForm<CreateUnitInput>({
    resolver: zodResolver(CreateUnitSchema),
    defaultValues: {
      facilityId,
      code: '',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
    },
  });

  async function onSubmit(values: CreateUnitInput) {
    try {
      await create.mutateAsync({ ...values, facilityId });
      toast.success('Trastero creado.');
      form.reset({
        facilityId,
        unitTypeId: values.unitTypeId,
        code: '',
        widthM: values.widthM,
        depthM: values.depthM,
        heightM: values.heightM,
      });
      // Mantiene el dialog abierto para crear varios seguidos.
    } catch (err) {
      if (err instanceof ApiError && (err.body as { code?: string }).code === 'unit_code_taken') {
        toast.error('Ya existe un trastero con ese código en este local.');
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar este trastero?')) return;
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
      cell: ({ row }) => row.original.areaM2.toFixed(2),
    },
    {
      accessorKey: 'basePriceMonthly',
      header: 'Precio',
      cell: ({ row }) => `${row.original.basePriceMonthly.toFixed(2)} €`,
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
            <Button variant="ghost" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/units/${row.original.id}`}>Abrir</Link>
            </DropdownMenuItem>
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
      columns={columns}
      data={units.data?.items ?? []}
      isLoading={units.isLoading}
      searchPlaceholder="Buscar por código..."
      toolbarRight={
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) form.reset({ facilityId, code: '', widthM: 2, depthM: 2, heightM: 2.5 });
          }}
        >
          <DialogTrigger asChild>
            <Button disabled={activeTypes.length === 0}>
              <Plus className="mr-1 h-4 w-4" /> Nuevo trastero
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nuevo trastero</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                <FormField
                  control={form.control}
                  name="unitTypeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tipo</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Selecciona un tipo" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {activeTypes.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Código</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="A-12, B-203..." />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(['widthM', 'depthM', 'heightM'] as const).map((k) => (
                    <FormField
                      key={k}
                      control={form.control}
                      name={k}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {k === 'widthM'
                              ? 'Ancho (m)'
                              : k === 'depthM'
                                ? 'Fondo (m)'
                                : 'Alto (m)'}
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              step="0.01"
                              {...field}
                              onChange={(e) => field.onChange(Number(e.target.value))}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cerrar
                  </Button>
                  <Button type="submit" disabled={form.formState.isSubmitting}>
                    {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      }
      emptyText={
        activeTypes.length === 0
          ? 'Antes de crear trasteros, define al menos un tipo en la pestaña "Tipos".'
          : 'Aún no has creado ningún trastero en este local.'
      }
    />
  );
}
