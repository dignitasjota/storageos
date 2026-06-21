'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateFacilityInput,
  CreateFacilitySchema,
  type FacilityDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateFacility, useDeleteFacility, useFacilities } from '@/lib/facilities/hooks';

export default function FacilitiesPage() {
  const facilities = useFacilities();
  const canManage = useHasPermission('facilities:manage');
  const [open, setOpen] = useState(false);
  const create = useCreateFacility();
  const remove = useDeleteFacility();

  const form = useForm<CreateFacilityInput>({
    resolver: zodResolver(CreateFacilitySchema),
    defaultValues: { name: '', city: '', country: 'ES', timezone: 'Europe/Madrid' },
  });

  async function onSubmit(values: CreateFacilityInput) {
    try {
      await create.mutateAsync(values);
      toast.success('Local creado.');
      form.reset();
      setOpen(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : 'No se pudo crear.';
      toast.error(msg);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar este local? Sus trasteros y plantas dejarán de ser accesibles.')) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Local borrado.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : 'Error al borrar.';
      toast.error(msg);
    }
  }

  const columns: ColumnDef<FacilityDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => (
        <Link href={`/facilities/${row.original.id}`} className="font-medium hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'city',
      header: 'Ciudad',
      cell: ({ row }) => row.original.city ?? '—',
    },
    {
      id: 'occupancy',
      header: 'Ocupación',
      cell: ({ row }) => {
        const { unitsTotal, unitsOccupied } = row.original;
        if (unitsTotal === 0) return <span className="text-muted-foreground">Sin trasteros</span>;
        const pct = Math.round((unitsOccupied / unitsTotal) * 100);
        return (
          <span className="tabular-nums">
            {unitsOccupied} / {unitsTotal} ({pct}%)
          </span>
        );
      },
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
            <DropdownMenuItem asChild>
              <Link href={`/facilities/${row.original.id}`}>Abrir</Link>
            </DropdownMenuItem>
            {canManage && (
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => handleDelete(row.original.id)}
              >
                Borrar
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Locales</h1>
        <p className="text-sm text-muted-foreground">
          Gestiona tus naves de self-storage. Cada local tiene sus plantas y sus trasteros.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={facilities.data ?? []}
        isLoading={facilities.isLoading}
        searchPlaceholder="Buscar local..."
        toolbarRight={
          canManage ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-1 h-4 w-4" /> Nuevo local
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Nuevo local</DialogTitle>
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
                      name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Ciudad</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value ?? ''} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="address"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Dirección</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value ?? ''} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                        Cancelar
                      </Button>
                      <Button type="submit" disabled={form.formState.isSubmitting}>
                        {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          ) : null
        }
        emptyText="Aún no has creado ningún local. Crea el primero para empezar a añadir trasteros."
      />
    </div>
  );
}
