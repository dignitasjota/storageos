'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateInvoiceSeriesInput,
  CreateInvoiceSeriesSchema,
  type InvoiceSeriesDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { GoCardlessCard } from './gocardless-card';
import { HoldedCard } from './holded-card';
import { MonthlyDigestCard } from './monthly-digest-card';
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
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateInvoiceSeries, useInvoiceSeries } from '@/lib/billing/hooks';
import { useSepaSettings, useUpdateSepaSettings } from '@/lib/sepa/hooks';
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
      <AutoChargeRetryCard />
      <AutoIssueCard />
      <LateFeeCard />
      <MonthlyDigestCard />
      <SepaSettingsCard />

      <HoldedCard />

      <RedsysCard />

      <GoCardlessCard />

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

/** Reintentos de cobro automático de las facturas vencidas (smart retry). */
function AutoChargeRetryCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();
  const [max, setMax] = useState(3);
  const [interval, setInterval] = useState(3);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (settings.data && !ready) {
      setMax(settings.data.autoChargeRetryMax);
      setInterval(settings.data.autoChargeRetryIntervalDays);
      setReady(true);
    }
  }, [settings.data, ready]);

  if (!canConfigure) return null;
  if (settings.isLoading || !settings.data) return null;

  const enabled = settings.data.autoChargeRetryEnabled;
  const autoCharge = settings.data.autoChargeOnIssue;

  async function save(next: {
    autoChargeRetryEnabled?: boolean;
    autoChargeRetryMax?: number;
    autoChargeRetryIntervalDays?: number;
  }) {
    try {
      await update.mutateAsync(next);
      toast.success('Reintentos de cobro actualizados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Reintentos de cobro</CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>
            {enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Reintenta cobrar automáticamente las facturas vencidas (con un intervalo entre intentos)
          antes de escalar al proceso de impago. Recupera cobros que fallaron por un rechazo puntual
          de la tarjeta o la domiciliación.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!autoCharge && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Requiere el «Cobro automático» activado.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Nº máximo de reintentos</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={max}
              onChange={(e) => setMax(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
          <div className="space-y-1">
            <Label>Días entre reintentos</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={interval}
              onChange={(e) => setInterval(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => save({ autoChargeRetryEnabled: !enabled })}
            variant={enabled ? 'destructive' : 'default'}
            disabled={update.isPending || (!autoCharge && !enabled)}
          >
            {enabled ? 'Desactivar' : 'Activar reintentos'}
          </Button>
          <Button
            variant="outline"
            onClick={() => save({ autoChargeRetryMax: max, autoChargeRetryIntervalDays: interval })}
            disabled={update.isPending}
          >
            Guardar ajustes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Emisión automática de las facturas recurrentes (sin revisión manual). */
function AutoIssueCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();

  if (!canConfigure) return null;
  if (settings.isLoading || !settings.data) return null;

  const enabled = settings.data.autoIssueRecurring;

  async function toggle() {
    try {
      await update.mutateAsync({ autoIssueRecurring: !enabled });
      toast.success(
        enabled
          ? 'Emisión automática desactivada: las recurrentes quedarán en borrador.'
          : 'Emisión automática activada: las facturas recurrentes se emitirán solas.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Emisión automática de recurrentes</CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>
            {enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Las facturas mensuales de los contratos se emiten automáticamente en vez de quedar en
          borrador para revisión manual. Útil con muchos contratos (evita emitir una a una).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Con Veri*Factu el hash es inmutable tras emitir; si prefieres revisar los borradores antes
          de emitir, déjalo desactivado y usa la acción «Emitir seleccionadas» del listado.
        </p>
        <Button
          onClick={toggle}
          variant={enabled ? 'destructive' : 'default'}
          disabled={update.isPending}
        >
          {update.isPending ? 'Guardando…' : enabled ? 'Desactivar' : 'Activar emisión automática'}
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

/** Config del acreedor para remesas SEPA. Solo owner (billing:configure). */
function SepaSettingsCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useSepaSettings(canConfigure);
  const update = useUpdateSepaSettings();

  const [creditorName, setCreditorName] = useState('');
  const [creditorId, setCreditorId] = useState('');
  const [creditorIban, setCreditorIban] = useState('');
  const [creditorBic, setCreditorBic] = useState('');
  const [loaded, setLoaded] = useState(false);

  if (!canConfigure || settings.isLoading || !settings.data) return null;
  const s = settings.data;
  if (!loaded && s.configured) {
    setCreditorName(s.creditorName);
    setCreditorId(s.creditorId);
    setCreditorBic(s.creditorBic ?? '');
    setLoaded(true);
  }

  async function save(enabled: boolean) {
    if (!creditorName.trim() || !creditorId.trim()) {
      toast.error('Indica el nombre y el identificador del acreedor.');
      return;
    }
    if (!s.configured && !creditorIban.trim()) {
      toast.error('Indica el IBAN del acreedor.');
      return;
    }
    try {
      await update.mutateAsync({
        creditorName,
        creditorId,
        // El IBAN solo se envía si se reescribe; si no, el backend conserva el actual.
        ...(creditorIban.trim() ? { creditorIban: creditorIban.trim() } : {}),
        creditorBic,
        enabled,
      });
      toast.success('Ajustes SEPA guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'IBAN no válido.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Remesas SEPA (acreedor)</CardTitle>
          <Badge variant={s.enabled ? 'default' : 'outline'}>
            {s.enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Datos del acreedor para generar el fichero de adeudos SEPA (pain.008) que subes a tu
          banco. El IBAN se guarda cifrado.
          {s.configured && s.creditorIbanLast4 && ` IBAN actual: ····${s.creditorIbanLast4}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">Nombre del acreedor</label>
            <Input
              value={creditorName}
              onChange={(e) => setCreditorName(e.target.value)}
              placeholder="Trasteros SL"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Identificador del acreedor</label>
            <Input
              value={creditorId}
              onChange={(e) => setCreditorId(e.target.value)}
              placeholder="ES12ZZZB12345678"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              IBAN del acreedor {s.configured && '(reescribir para cambiar)'}
            </label>
            <Input
              value={creditorIban}
              onChange={(e) => setCreditorIban(e.target.value)}
              placeholder={
                s.configured ? `····${s.creditorIbanLast4}` : 'ES91 2100 0418 4502 0005 1332'
              }
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">BIC (opcional)</label>
            <Input
              value={creditorBic}
              onChange={(e) => setCreditorBic(e.target.value)}
              placeholder="CAIXESBBXXX"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => save(s.enabled)} disabled={update.isPending}>
            Guardar
          </Button>
          <Button
            variant={s.enabled ? 'destructive' : 'outline'}
            onClick={() => save(!s.enabled)}
            disabled={update.isPending}
          >
            {s.enabled ? 'Desactivar' : 'Activar remesas SEPA'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
