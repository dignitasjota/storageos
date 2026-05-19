'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateInvoiceSeriesInput,
  CreateInvoiceSeriesSchema,
  type InvoiceSeriesDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { useCreateInvoiceSeries, useInvoiceSeries } from '@/lib/billing/hooks';

export default function BillingSettingsPage() {
  const series = useInvoiceSeries();
  const create = useCreateInvoiceSeries();
  const [open, setOpen] = useState(false);

  const form = useForm<CreateInvoiceSeriesInput>({
    resolver: zodResolver(CreateInvoiceSeriesSchema),
    defaultValues: {
      code: 'A',
      name: 'Serie principal',
      prefix: 'FA',
      yearScope: true,
      isDefault: true,
    },
  });

  async function onSubmit(values: CreateInvoiceSeriesInput) {
    try {
      await create.mutateAsync(values);
      toast.success('Serie creada.');
      form.reset();
      setOpen(false);
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.body as { code?: string }).code === 'invoice_series_code_taken'
      ) {
        toast.error('Ya existe una serie con ese código.');
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<InvoiceSeriesDto>[] = [
    { accessorKey: 'code', header: 'Código' },
    { accessorKey: 'name', header: 'Nombre' },
    {
      accessorKey: 'prefix',
      header: 'Prefijo',
      cell: ({ row }) => <code className="font-mono text-xs">{row.original.prefix}</code>,
    },
    {
      accessorKey: 'yearScope',
      header: 'Año en numeración',
      cell: ({ row }) => (
        <Badge variant={row.original.yearScope ? 'default' : 'outline'}>
          {row.original.yearScope ? 'Sí' : 'No'}
        </Badge>
      ),
    },
    {
      accessorKey: 'nextNumber',
      header: 'Próximo número',
      cell: ({ row }) => <span className="font-mono tabular-nums">{row.original.nextNumber}</span>,
    },
    {
      accessorKey: 'isDefault',
      header: 'Default',
      cell: ({ row }) =>
        row.original.isDefault ? (
          <Badge>Default</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'isActive',
      header: 'Estado',
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? 'default' : 'outline'}>
          {row.original.isActive ? 'Activa' : 'Inactiva'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facturación</h1>
        <p className="text-sm text-muted-foreground">
          Configura las series de facturación. Una serie controla la numeración secuencial e
          inmutable que exige Verifactu.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={series.data ?? []}
        isLoading={series.isLoading}
        toolbarRight={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-1 h-4 w-4" /> Nueva serie
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nueva serie de facturación</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="code"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Código</FormLabel>
                          <FormControl>
                            <Input {...field} maxLength={20} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="prefix"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Prefijo</FormLabel>
                          <FormControl>
                            <Input {...field} maxLength={20} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
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
                    name="yearScope"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2">
                        <FormControl>
                          <Checkbox
                            checked={field.value ?? true}
                            onCheckedChange={(v) => field.onChange(v === true)}
                          />
                        </FormControl>
                        <FormLabel className="!mt-0">Incluir año en la numeración</FormLabel>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="isDefault"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2">
                        <FormControl>
                          <Checkbox
                            checked={field.value ?? false}
                            onCheckedChange={(v) => field.onChange(v === true)}
                          />
                        </FormControl>
                        <FormLabel className="!mt-0">Marcar como serie por defecto</FormLabel>
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
        }
        emptyText="Aún no has creado ninguna serie. Crea al menos una antes de emitir facturas."
      />
    </div>
  );
}
