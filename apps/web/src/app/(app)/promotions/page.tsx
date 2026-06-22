'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreatePromotionSchema,
  type CreatePromotionInput,
  type PromotionDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus, Trash2 } from 'lucide-react';
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
import { useHasPermission } from '@/lib/auth/hooks';
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
  const promotions = usePromotions();
  const update = useUpdatePromotion();
  const remove = useDeletePromotion();
  const canManage = useHasPermission('promotions:manage');

  async function toggleActive(p: PromotionDto) {
    try {
      await update.mutateAsync({ id: p.id, input: { isActive: !p.isActive } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar esta promoción? No afecta a contratos que ya la usaron.')) return;
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
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage && (
          <Button variant="ghost" size="icon" onClick={() => handleDelete(row.original.id)}>
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
          cuota).
        </p>
      </div>

      <DataTable
        columns={columns}
        data={promotions.data ?? []}
        isLoading={promotions.isLoading}
        searchPlaceholder="Buscar por código o nombre..."
        emptyText="Aún no has creado ninguna promoción."
        toolbarRight={canManage ? <CreatePromotionDialog /> : null}
      />
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
    },
  });

  async function onSubmit(values: CreatePromotionInput) {
    try {
      await create.mutateAsync(values);
      toast.success('Promoción creada.');
      form.reset();
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
            {form.watch('discountType') === 'free_months' && (
              <p className="text-xs text-muted-foreground">
                Nota: los códigos de “meses gratis” aún no se aplican automáticamente en el alta de
                contrato (próximamente).
              </p>
            )}
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
