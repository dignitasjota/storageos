'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateUnitTypeInput,
  CreateUnitTypeSchema,
  type UnitTypeDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import {
  useCreateUnitType,
  useDeleteUnitType,
  useUnitTypes,
  useUpdateUnitType,
} from '@/lib/facilities/hooks';

export function FacilityUnitTypesTab() {
  const types = useUnitTypes();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UnitTypeDto | null>(null);
  const create = useCreateUnitType();
  const update = useUpdateUnitType();
  const remove = useDeleteUnitType();

  const form = useForm<CreateUnitTypeInput>({
    resolver: zodResolver(CreateUnitTypeSchema),
    defaultValues: {
      name: '',
      defaultPriceMonthly: 50,
      defaultDepositAmount: 0,
      color: '#3366ff',
      features: {},
    },
  });

  useEffect(() => {
    if (editing) {
      form.reset({
        name: editing.name,
        description: editing.description ?? '',
        defaultPriceMonthly: editing.defaultPriceMonthly,
        defaultDepositAmount: editing.defaultDepositAmount,
        color: editing.color,
        features: editing.features,
      });
    }
  }, [editing, form]);

  async function onSubmit(values: CreateUnitTypeInput) {
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, input: values });
        toast.success('Tipo actualizado.');
      } else {
        await create.mutateAsync(values);
        toast.success('Tipo creado.');
      }
      setOpen(false);
      setEditing(null);
      form.reset();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.body as { code?: string }).code === 'unit_type_name_taken'
      ) {
        toast.error('Ya existe un tipo con ese nombre.');
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar este tipo? Si tiene trasteros asignados, se desactivará.')) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Tipo eliminado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<UnitTypeDto>[] = [
    {
      accessorKey: 'color',
      header: '',
      cell: ({ row }) => (
        <span
          aria-label={`Color ${row.original.color}`}
          className="inline-block size-5 rounded border"
          style={{ backgroundColor: row.original.color }}
        />
      ),
    },
    { accessorKey: 'name', header: 'Nombre' },
    {
      accessorKey: 'defaultPriceMonthly',
      header: 'Precio mensual',
      cell: ({ row }) => `${row.original.defaultPriceMonthly.toFixed(2)} €`,
    },
    {
      accessorKey: 'unitsCount',
      header: 'Trasteros',
    },
    {
      accessorKey: 'isActive',
      header: 'Estado',
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? 'default' : 'outline'}>
          {row.original.isActive ? 'Activo' : 'Inactivo'}
        </Badge>
      ),
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
            <DropdownMenuItem
              onClick={() => {
                setEditing(row.original);
                setOpen(true);
              }}
            >
              Editar
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

  return (
    <DataTable
      columns={columns}
      data={types.data ?? []}
      isLoading={types.isLoading}
      toolbarRight={
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              setEditing(null);
              form.reset();
            }
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Nuevo tipo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? 'Editar tipo' : 'Nuevo tipo'}</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nombre</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="defaultPriceMonthly"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Precio mensual (€)</FormLabel>
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
                <FormField
                  control={form.control}
                  name="defaultDepositAmount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fianza / depósito (€)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          {...field}
                          value={field.value ?? 0}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Se cobra junto a la 1ª mensualidad en la reserva online. 0 = sin fianza.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="color"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Color</FormLabel>
                      <FormControl>
                        <Input type="color" {...field} className="h-10 w-20" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      setEditing(null);
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={form.formState.isSubmitting}>
                    {form.formState.isSubmitting ? 'Guardando...' : 'Guardar'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      }
      emptyText="Aún no has creado ningún tipo. Por ejemplo: S (1×1×2 m), M (2×2×2.5 m), L (3×3×2.5 m)."
    />
  );
}
