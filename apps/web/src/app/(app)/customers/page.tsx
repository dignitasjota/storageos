'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateCustomerInput,
  CreateCustomerSchema,
  type CustomerDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Upload } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateCustomer, useCustomers, useDeleteCustomer } from '@/lib/customers/hooks';

export default function CustomersPage() {
  const customers = useCustomers();
  const create = useCreateCustomer();
  const remove = useDeleteCustomer();
  // RBAC v2 (PR1): borrar inquilinos es owner-only (`customers:delete`).
  const canDelete = useHasPermission('customers:delete');
  const canWrite = useHasPermission('customers:write');
  const canImport = useHasPermission('imports:manage');
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'individual' | 'business'>('individual');

  const form = useForm<CreateCustomerInput>({
    resolver: zodResolver(CreateCustomerSchema),
    defaultValues: {
      customerType: 'individual',
      country: 'ES',
      firstName: '',
      lastName: '',
      companyName: '',
      email: '',
      phone: '',
      documentType: 'DNI',
      documentNumber: '',
    },
  });

  async function onSubmit(values: CreateCustomerInput) {
    try {
      await create.mutateAsync({ ...values, customerType: type });
      toast.success('Inquilino creado.');
      form.reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar este inquilino? Es un soft delete: el histórico se mantiene.')) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Inquilino borrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<CustomerDto>[] = [
    {
      accessorKey: 'displayName',
      header: 'Nombre',
      cell: ({ row }) => (
        <Link href={`/customers/${row.original.id}`} className="font-medium hover:underline">
          {row.original.displayName}
        </Link>
      ),
    },
    {
      accessorKey: 'customerType',
      header: 'Tipo',
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.customerType === 'business' ? 'Empresa' : 'Particular'}
        </Badge>
      ),
    },
    {
      accessorKey: 'documentNumber',
      header: 'Documento',
      cell: ({ row }) =>
        row.original.documentNumber ? (
          <span className="font-mono text-xs">
            {row.original.documentType} {row.original.documentNumber}
          </span>
        ) : (
          '—'
        ),
    },
    {
      accessorKey: 'email',
      header: 'Email',
      cell: ({ row }) => row.original.email ?? '—',
    },
    {
      id: 'activity',
      header: 'Actividad',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.activeContracts} contratos · {row.original.pendingReservations} reservas
        </span>
      ),
    },
    {
      accessorKey: 'kycVerified',
      header: 'KYC',
      cell: ({ row }) => (
        <Badge variant={row.original.kycVerified ? 'default' : 'outline'}>
          {row.original.kycVerified ? 'Verificado' : 'Pendiente'}
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
              <Link href={`/customers/${row.original.id}`}>Abrir</Link>
            </DropdownMenuItem>
            {canDelete && (
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
        <h1 className="text-2xl font-semibold tracking-tight">Inquilinos</h1>
        <p className="text-sm text-muted-foreground">
          Gestiona los clientes finales que alquilan trasteros.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={customers.data ?? []}
        isLoading={customers.isLoading}
        searchPlaceholder="Buscar por nombre, email, documento..."
        toolbarRight={
          <>
            {canImport && (
              <Button asChild variant="outline">
                <Link href="/customers/import">
                  <Upload className="mr-1 h-4 w-4" /> Importar
                </Link>
              </Button>
            )}
            <Dialog open={open && canWrite} onOpenChange={setOpen}>
              {canWrite && (
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-1 h-4 w-4" /> Nuevo inquilino
                  </Button>
                </DialogTrigger>
              )}
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Nuevo inquilino</DialogTitle>
                </DialogHeader>
                <Tabs value={type} onValueChange={(v) => setType(v as 'individual' | 'business')}>
                  <TabsList className="w-full">
                    <TabsTrigger value="individual" className="flex-1">
                      Particular
                    </TabsTrigger>
                    <TabsTrigger value="business" className="flex-1">
                      Empresa
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Form {...form}>
                  <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                    {type === 'individual' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <FormField
                          control={form.control}
                          name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Nombre</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value ?? ''} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Apellidos</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value ?? ''} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    ) : (
                      <FormField
                        control={form.control}
                        name="companyName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Empresa</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="documentType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tipo doc.</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value ?? 'DNI'}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="DNI">DNI</SelectItem>
                                <SelectItem value="NIE">NIE</SelectItem>
                                <SelectItem value="CIF">CIF</SelectItem>
                                <SelectItem value="Pasaporte">Pasaporte</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="documentNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Número</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} type="email" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Teléfono</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
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
          </>
        }
        emptyText="No hay inquilinos todavía. Crea el primero para empezar a firmar contratos."
      />
    </div>
  );
}
