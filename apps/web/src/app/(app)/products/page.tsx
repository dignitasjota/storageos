'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateProductInput,
  type CreateProductSaleInput,
  CreateProductSaleSchema,
  CreateProductSchema,
  type ProductDto,
  type ProductSaleDto,
  type ProductSaleStatusValue,
  type ProductTypeValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCustomers } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useCancelProductSale,
  useCreateProduct,
  useCreateProductSale,
  useDeleteProduct,
  useProductSales,
  useProducts,
} from '@/lib/products/hooks';

const PRODUCT_TYPE_LABELS: Record<ProductTypeValue, string> = {
  lock: 'Candado',
  box: 'Caja',
  packaging: 'Embalaje',
  insurance: 'Seguro',
  other: 'Otro',
};

const SALE_STATUS_LABELS: Record<
  ProductSaleStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  paid: { label: 'Pagada', variant: 'default' },
  pending: { label: 'Pendiente', variant: 'secondary' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

export default function ProductsPage() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Productos</h1>
        <p className="text-sm text-muted-foreground">
          Candados, cajas, embalaje y seguros. Vende añadidos al alquiler con factura automática.
        </p>
      </div>

      <Tabs defaultValue="catalog" className="w-full">
        <TabsList>
          <TabsTrigger value="catalog">Catálogo</TabsTrigger>
          <TabsTrigger value="sales">Ventas</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="mt-4">
          <CatalogTab />
        </TabsContent>
        <TabsContent value="sales" className="mt-4">
          <SalesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// Catálogo
// ============================================================================

function CatalogTab() {
  const products = useProducts();
  const create = useCreateProduct();
  const remove = useDeleteProduct();
  const [createOpen, setCreateOpen] = useState(false);

  const form = useForm<CreateProductInput>({
    resolver: zodResolver(CreateProductSchema),
    defaultValues: {
      sku: '',
      name: '',
      description: '',
      type: 'other',
      price: 0,
      taxRate: 21,
      isActive: true,
    },
  });

  async function onSubmit(values: CreateProductInput) {
    try {
      const payload: CreateProductInput = {
        sku: values.sku,
        name: values.name,
        type: values.type,
        price: values.price,
        taxRate: values.taxRate,
        isActive: values.isActive,
        ...(values.description ? { description: values.description } : {}),
      };
      await create.mutateAsync(payload);
      toast.success('Producto creado.');
      form.reset();
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Desactivar este producto?')) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Producto desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<ProductDto>[] = [
    {
      accessorKey: 'sku',
      header: 'SKU',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.sku}</span>,
    },
    { accessorKey: 'name', header: 'Nombre' },
    {
      accessorKey: 'type',
      header: 'Tipo',
      cell: ({ row }) => <Badge variant="outline">{PRODUCT_TYPE_LABELS[row.original.type]}</Badge>,
    },
    {
      accessorKey: 'price',
      header: 'Precio',
      cell: ({ row }) =>
        row.original.price.toLocaleString('es-ES', {
          style: 'currency',
          currency: 'EUR',
        }),
    },
    {
      accessorKey: 'totalStock',
      header: 'Stock total',
      cell: ({ row }) => row.original.totalStock,
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
      cell: ({ row }) =>
        row.original.isActive && (
          <Button variant="ghost" size="icon" onClick={() => handleDelete(row.original.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        ),
    },
  ];

  if (products.isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={products.data ?? []}
      isLoading={products.isLoading}
      searchPlaceholder="Buscar por SKU o nombre..."
      emptyText="No hay productos. Añade el primero (ej. candado standard)."
      toolbarRight={
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Nuevo producto
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Nuevo producto</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="sku"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SKU</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tipo</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value ?? 'other'}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(Object.keys(PRODUCT_TYPE_LABELS) as ProductTypeValue[]).map((t) => (
                              <SelectItem key={t} value={t}>
                                {PRODUCT_TYPE_LABELS[t]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                        <Input {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Descripción</FormLabel>
                      <FormControl>
                        <Textarea {...field} value={field.value ?? ''} rows={2} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Precio (EUR)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            {...field}
                            value={field.value ?? 0}
                            onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="taxRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>IVA (%)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            {...field}
                            value={field.value ?? 21}
                            onChange={(e) => field.onChange(Number(e.target.value) || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
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
    />
  );
}

// ============================================================================
// Ventas
// ============================================================================

function SalesTab() {
  const sales = useProductSales();
  const cancel = useCancelProductSale();
  const [createOpen, setCreateOpen] = useState(false);

  async function handleCancel(id: string) {
    if (!confirm('¿Cancelar esta venta? El stock se devolverá al inventario.')) return;
    try {
      await cancel.mutateAsync(id);
      toast.success('Venta cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<ProductSaleDto>[] = [
    {
      accessorKey: 'soldAt',
      header: 'Fecha',
      cell: ({ row }) => new Date(row.original.soldAt).toLocaleString('es-ES'),
    },
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) => row.original.customerName ?? '(venta libre)',
    },
    { accessorKey: 'facilityName', header: 'Local' },
    {
      id: 'items',
      header: 'Líneas',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.items.length} producto
          {row.original.items.length === 1 ? '' : 's'}
        </span>
      ),
    },
    {
      accessorKey: 'total',
      header: 'Total',
      cell: ({ row }) =>
        row.original.total.toLocaleString('es-ES', {
          style: 'currency',
          currency: 'EUR',
        }),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = SALE_STATUS_LABELS[row.original.status];
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        row.original.status !== 'cancelled' && (
          <Button variant="ghost" size="sm" onClick={() => handleCancel(row.original.id)}>
            Cancelar
          </Button>
        ),
    },
  ];

  if (sales.isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={sales.data ?? []}
      isLoading={sales.isLoading}
      emptyText="Aún no hay ventas registradas."
      toolbarRight={
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Nueva venta
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Nueva venta</DialogTitle>
            </DialogHeader>
            <NewSaleForm onDone={() => setCreateOpen(false)} />
          </DialogContent>
        </Dialog>
      }
    />
  );
}

function NewSaleForm({ onDone }: { onDone: () => void }) {
  const facilities = useFacilities();
  const customers = useCustomers();
  const products = useProducts({ isActive: true });
  const create = useCreateProductSale();

  const form = useForm<CreateProductSaleInput>({
    resolver: zodResolver(CreateProductSaleSchema),
    defaultValues: {
      facilityId: '',
      items: [],
      notes: '',
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  async function onSubmit(values: CreateProductSaleInput) {
    try {
      const payload: CreateProductSaleInput = {
        facilityId: values.facilityId,
        items: values.items,
        ...(values.customerId ? { customerId: values.customerId } : {}),
        ...(values.notes ? { notes: values.notes } : {}),
      };
      await create.mutateAsync(payload);
      toast.success('Venta creada.');
      form.reset();
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  // Calcula total estimado a partir del precio del catálogo
  const watchItems = form.watch('items');
  const estimatedTotal = watchItems.reduce((acc, it) => {
    const p = (products.data ?? []).find((x) => x.id === it.productId);
    if (!p) return acc;
    return acc + p.price * (it.quantity || 0);
  }, 0);

  return (
    <Form {...form}>
      <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="facilityId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Local</FormLabel>
                <Select onValueChange={field.onChange} value={field.value ?? ''}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecciona un local" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(facilities.data ?? []).map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
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
            name="customerId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Inquilino (opcional)</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
                  value={field.value ?? 'none'}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="(venta libre)" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="none">(venta libre)</SelectItem>
                    {(customers.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Líneas</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ productId: '', quantity: 1 })}
            >
              <Plus className="mr-1 h-4 w-4" /> Añadir
            </Button>
          </div>
          {fields.length === 0 && (
            <p className="text-xs text-muted-foreground">Añade al menos un producto.</p>
          )}
          {fields.map((f, idx) => (
            <div key={f.id} className="flex items-end gap-2">
              <FormField
                control={form.control}
                name={`items.${idx}.productId`}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-xs">Producto</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ''}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(products.data ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name} ·{' '}
                            {p.price.toLocaleString('es-ES', {
                              style: 'currency',
                              currency: 'EUR',
                            })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`items.${idx}.quantity`}
                render={({ field }) => (
                  <FormItem className="w-24">
                    <FormLabel className="text-xs">Cantidad</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        value={field.value ?? 1}
                        onChange={(e) => field.onChange(Number(e.target.value) || 1)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => remove(idx)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notas (opcional)</FormLabel>
              <FormControl>
                <Textarea {...field} value={field.value ?? ''} rows={2} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          Total estimado:{' '}
          <strong>
            {estimatedTotal.toLocaleString('es-ES', {
              style: 'currency',
              currency: 'EUR',
            })}
          </strong>
          <span className="ml-2 text-xs text-muted-foreground">
            (incluye precio base; impuestos se calculan en el servidor)
          </span>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting || fields.length === 0}>
            {form.formState.isSubmitting ? 'Creando...' : 'Crear venta'}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
