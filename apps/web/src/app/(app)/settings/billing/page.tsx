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

import { HoldedCard } from './holded-card';
import { RedsysCard } from './redsys-card';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateInvoiceSeries, useInvoiceSeries } from '@/lib/billing/hooks';
import {
  useTenantBillingSettings,
  useUpdateTenantBillingSettings,
} from '@/lib/tenant-settings/hooks';

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

      <AutoChargeCard />
      <LateFeeCard />

      <HoldedCard />

      <RedsysCard />

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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

/**
 * Cobro automático al emitir factura. Solo visible para owners (el GET es
 * accesible a cualquier user autenticado, pero el PATCH exige owner).
 */
function AutoChargeCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();

  if (!canConfigure) return null;
  if (settings.isLoading || !settings.data) return null;

  const enabled = settings.data.autoChargeOnIssue;

  async function toggle() {
    try {
      await update.mutateAsync({ autoChargeOnIssue: !enabled });
      toast.success(
        enabled
          ? 'Cobro automático desactivado.'
          : 'Cobro automático activado: cada factura emitida se cobrará al método predeterminado.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Cobro automático</CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>
            {enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Al emitir una factura se intenta cobrar automáticamente al método de pago predeterminado
          del cliente (tarjeta o domiciliación SEPA).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Las facturas de clientes sin método de pago guardado (o las simplificadas F2) quedan
          pendientes como hasta ahora, sin error. Los cobros SEPA tardan 2-5 días hábiles en
          confirmarse; el estado de la factura se actualiza solo.
        </p>
        <Button
          onClick={toggle}
          variant={enabled ? 'destructive' : 'default'}
          disabled={update.isPending}
        >
          {update.isPending ? 'Guardando…' : enabled ? 'Desactivar' : 'Activar cobro automático'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Recargo por mora (opt-in). Solo owner (billing:configure). */
function LateFeeCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();

  if (!canConfigure || settings.isLoading || !settings.data) return null;
  const s = settings.data;

  async function save(patch: Partial<typeof s>) {
    try {
      await update.mutateAsync(patch);
      toast.success('Recargo por mora actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Recargo por mora</CardTitle>
          <Badge variant={s.lateFeeEnabled ? 'default' : 'outline'}>
            {s.lateFeeEnabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          A los días indicados de vencimiento, el dunning emite una factura de recargo (separada,
          conforme a Veri*Factu). También puedes aplicarlo a mano desde una factura vencida.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Tipo</label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={s.lateFeeType}
              onChange={(e) => save({ lateFeeType: e.target.value as 'percentage' | 'fixed' })}
              disabled={update.isPending}
            >
              <option value="percentage">Porcentaje (%)</option>
              <option value="fixed">Importe fijo (€)</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              {s.lateFeeType === 'percentage' ? 'Porcentaje' : 'Euros'}
            </label>
            <Input
              type="number"
              defaultValue={s.lateFeeValue}
              min={0}
              step="0.01"
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== s.lateFeeValue) void save({ lateFeeValue: v });
              }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Días tras vencimiento</label>
            <Input
              type="number"
              defaultValue={s.lateFeeGraceDays}
              min={0}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== s.lateFeeGraceDays) void save({ lateFeeGraceDays: v });
              }}
            />
          </div>
        </div>
        <Button
          onClick={() => save({ lateFeeEnabled: !s.lateFeeEnabled })}
          variant={s.lateFeeEnabled ? 'destructive' : 'default'}
          disabled={update.isPending}
        >
          {update.isPending
            ? 'Guardando…'
            : s.lateFeeEnabled
              ? 'Desactivar recargo'
              : 'Activar recargo por mora'}
        </Button>
      </CardContent>
    </Card>
  );
}
