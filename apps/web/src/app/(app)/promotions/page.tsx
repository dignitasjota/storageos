'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreatePromotionSchema,
  type CreatePromotionInput,
  type PromotionDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { OptionalDateSelect } from '@/components/optional-date-select';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { formatDate } from '@/lib/format';
import {
  useCreatePromotion,
  useDeletePromotion,
  usePromotions,
  useUpdatePromotion,
} from '@/lib/promotions/hooks';

function discountLabel(p: PromotionDto): string {
  if (p.discountType === 'percentage') return `${p.discountValue}%`;
  if (p.discountType === 'fixed') return `${p.discountValue} € / mes`;
  return `${p.discountValue} mes(es) gratis`;
}

export default function PromotionsPage() {
  const ask = useConfirm();
  const promotions = usePromotions();
  const update = useUpdatePromotion();
  const remove = useDeletePromotion();
  // Valen para todo el negocio: las gestiona quien ve todos los locales.
  const companyWide = useCompanyWide();
  const canManage = useHasPermission('promotions:manage') && companyWide;

  async function toggleActive(p: PromotionDto) {
    try {
      await update.mutateAsync({ id: p.id, input: { isActive: !p.isActive } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function toggleWeb(p: PromotionDto) {
    try {
      await update.mutateAsync({ id: p.id, input: { announceOnWeb: !p.announceOnWeb } });
      toast.success(
        p.announceOnWeb
          ? 'Ya no se anuncia en tu web.'
          : 'Se anuncia en tu web y su código vale en la reserva online.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (
      !(await ask({
        title: '¿Eliminar esta promoción? Si ya se ha usado no se puede borrar: desactívala.',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync(id);
      toast.success('Promoción eliminada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<PromotionDto>[] = [
    {
      accessorKey: 'code',
      header: 'Código',
      cell: ({ row }) => <span className="font-mono font-medium">{row.original.code}</span>,
    },
    { accessorKey: 'name', header: 'Nombre' },
    { id: 'discount', header: 'Descuento', cell: ({ row }) => discountLabel(row.original) },
    {
      id: 'uses',
      header: 'Usos',
      cell: ({ row }) =>
        `${row.original.usedCount}${row.original.maxUses ? ` / ${row.original.maxUses}` : ''}`,
    },
    {
      id: 'validity',
      header: 'Vigencia',
      cell: ({ row }) => {
        const p = row.original;
        if (!p.validFrom && !p.validUntil)
          return <span className="text-muted-foreground">Siempre</span>;
        return (
          <span className="text-sm">
            {p.validFrom ? formatDate(p.validFrom) : '—'} →{' '}
            {p.validUntil ? formatDate(p.validUntil) : '—'}
          </span>
        );
      },
    },
    {
      accessorKey: 'isActive',
      header: 'Estado',
      cell: ({ row }) =>
        canManage ? (
          <button type="button" onClick={() => toggleActive(row.original)}>
            <Badge variant={row.original.isActive ? 'default' : 'outline'}>
              {row.original.isActive ? 'Activa' : 'Inactiva'}
            </Badge>
          </button>
        ) : (
          <Badge variant={row.original.isActive ? 'default' : 'outline'}>
            {row.original.isActive ? 'Activa' : 'Inactiva'}
          </Badge>
        ),
    },
    {
      id: 'web',
      header: 'En la web',
      cell: ({ row }) =>
        canManage ? (
          <button
            type="button"
            onClick={() => toggleWeb(row.original)}
            title="Anunciarla en tu web: su código valdrá en la reserva online"
          >
            <Badge variant={row.original.announceOnWeb ? 'default' : 'outline'}>
              {row.original.announceOnWeb ? 'Anunciada' : 'No'}
            </Badge>
          </button>
        ) : (
          <Badge variant={row.original.announceOnWeb ? 'default' : 'outline'}>
            {row.original.announceOnWeb ? 'Anunciada' : 'No'}
          </Badge>
        ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleDelete(row.original.id)}
            aria-label="Eliminar"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Promociones</h1>
        <p className="text-sm text-muted-foreground">
          Códigos de descuento aplicables al crear un contrato (descuento recurrente sobre la
          cuota). Para un descuento solo en el pago que se hace al contratar, usa los{' '}
          <Link href="/coupons" className="underline">
            cupones
          </Link>
          . La que marques «En la web» se anuncia en tu web y su código vale en la reserva online;
          las demás las aplica el equipo.
        </p>
        {!companyWide && (
          <p className="mt-1 text-xs text-muted-foreground">
            Las promociones valen para todo el negocio: las crea y cambia quien ve todos los
            locales.
          </p>
        )}
      </div>

      {promotions.isError ? (
        <SectionError onRetry={() => void promotions.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={promotions.data ?? []}
          isLoading={promotions.isLoading}
          searchPlaceholder="Buscar por código o nombre..."
          guide="promociones"
          emptyText="Una promoción descuenta todas las cuotas del contrato en el que se aplica."
          toolbarRight={canManage ? <CreatePromotionDialog /> : null}
        />
      )}
    </div>
  );
}

function CreatePromotionDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreatePromotion();
  const form = useForm<CreatePromotionInput>({
    resolver: zodResolver(CreatePromotionSchema),
    defaultValues: {
      code: '',
      name: '',
      discountType: 'percentage',
      discountValue: 10,
      appliesTo: {},
      isActive: true,
      announceOnWeb: false,
    },
  });

  const [fromDay, setFromDay] = useState('');
  const [untilDay, setUntilDay] = useState('');

  async function onSubmit(values: CreatePromotionInput) {
    if (fromDay && untilDay && untilDay < fromDay) {
      toast.error('La fecha de fin no puede ser anterior a la de inicio.');
      return;
    }
    try {
      await create.mutateAsync({
        ...values,
        // Días completos en hora local: desde las 00:00 hasta las 23:59.
        ...(fromDay ? { validFrom: new Date(`${fromDay}T00:00:00`).toISOString() } : {}),
        ...(untilDay ? { validUntil: new Date(`${untilDay}T23:59:59`).toISOString() } : {}),
      });
      toast.success('Promoción creada.');
      form.reset();
      setFromDay('');
      setUntilDay('');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Nueva promoción
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva promoción</DialogTitle>
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
                      <Input placeholder="VERANO20" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nombre</FormLabel>
                    <FormControl>
                      <Input placeholder="Promo verano" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="discountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tipo</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="percentage">Porcentaje (%)</SelectItem>
                        <SelectItem value="fixed">Importe fijo (€/mes)</SelectItem>
                        <SelectItem value="free_months">Meses gratis</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="discountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Valor</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="maxUses"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Usos máximos (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value ? Number(e.target.value) : undefined)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 gap-3">
              <div className="space-y-1.5">
                <Label>Válida desde (opcional)</Label>
                <OptionalDateSelect value={fromDay} onChange={setFromDay} />
              </div>
              <div className="space-y-1.5">
                <Label>Válida hasta (opcional)</Label>
                <OptionalDateSelect value={untilDay} onChange={setUntilDay} />
              </div>
            </div>
            {form.watch('discountType') === 'free_months' && (
              <p className="text-xs text-muted-foreground">
                Los meses gratis se aplican a las primeras facturas mensuales del contrato. No se
                pueden combinar con el pago semestral o anual.
              </p>
            )}
            <FormField
              control={form.control}
              name="announceOnWeb"
              render={({ field }) => (
                <FormItem className="flex items-start gap-2 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(v === true)}
                      className="mt-0.5"
                    />
                  </FormControl>
                  <div>
                    <FormLabel className="font-normal">Anunciarla en tu web</FormLabel>
                    <p className="text-xs text-muted-foreground">
                      Sale en un aviso de tu web con su código, que valdrá también en la reserva
                      online. Sin marcar, solo la aplica el equipo al crear un contrato.
                    </p>
                  </div>
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
  );
}
