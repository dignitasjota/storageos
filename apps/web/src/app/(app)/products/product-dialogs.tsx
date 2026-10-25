'use client';

import { type ProductDto, type ProductTypeValue } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useFacilities } from '@/lib/facilities/hooks';
import { useProductStock, useSetStock, useUpdateProduct } from '@/lib/products/hooks';

export const PRODUCT_TYPE_LABELS: Record<ProductTypeValue, string> = {
  lock: 'Candado',
  box: 'Caja',
  packaging: 'Embalaje',
  insurance: 'Seguro',
  other: 'Otro',
};

/** Editar un producto: datos, precio, IVA y si está a la venta. */
export function EditProductDialog({
  product,
  onClose,
}: {
  product: ProductDto | null;
  onClose: () => void;
}) {
  const update = useUpdateProduct(product?.id ?? '');
  const [form, setForm] = useState({
    sku: '',
    name: '',
    description: '',
    type: 'other' as ProductTypeValue,
    price: '0',
    taxRate: '21',
    isActive: true,
  });

  useEffect(() => {
    if (!product) return;
    setForm({
      sku: product.sku,
      name: product.name,
      description: product.description ?? '',
      type: product.type,
      price: String(product.price),
      taxRate: String(product.taxRate),
      isActive: product.isActive,
    });
  }, [product]);

  async function save() {
    if (!product) return;
    const price = Number(form.price);
    const taxRate = Number(form.taxRate);
    if (!(price > 0) || !(taxRate >= 0 && taxRate <= 100)) {
      toast.error('Revisa el precio y el IVA.');
      return;
    }
    try {
      await update.mutateAsync({
        sku: form.sku.trim(),
        name: form.name.trim(),
        description: form.description.trim(),
        type: form.type,
        price,
        taxRate,
        isActive: form.isActive,
      });
      toast.success('Producto actualizado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Editar producto</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ep-sku">SKU</Label>
              <Input
                id="ep-sku"
                value={form.sku}
                onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as ProductTypeValue }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRODUCT_TYPE_LABELS) as ProductTypeValue[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {PRODUCT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ep-name">Nombre</Label>
            <Input
              id="ep-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ep-desc">Descripción</Label>
            <Textarea
              id="ep-desc"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ep-price">Precio sin IVA (€)</Label>
              <Input
                id="ep-price"
                type="number"
                step="0.01"
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ep-tax">IVA (%)</Label>
              <Input
                id="ep-tax"
                type="number"
                step="1"
                value={form.taxRate}
                onChange={(e) => setForm((f) => ({ ...f, taxRate: e.target.value }))}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.isActive}
              onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v === true }))}
            />
            A la venta (en el mostrador y en el portal del inquilino)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Stock del producto en cada local: se fija la cantidad que hay. */
export function ProductStockDialog({
  product,
  onClose,
}: {
  product: ProductDto | null;
  onClose: () => void;
}) {
  const facilities = useFacilities();
  const stock = useProductStock(product?.id);
  const setStock = useSetStock(product?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!product) return;
    const current: Record<string, string> = {};
    for (const row of stock.data ?? []) current[row.facilityId] = String(row.quantity);
    setValues(current);
  }, [product, stock.data]);

  async function save(facilityId: string) {
    const quantity = Number(values[facilityId] ?? '0');
    if (!Number.isInteger(quantity) || quantity < 0) {
      toast.error('La cantidad tiene que ser un número entero.');
      return;
    }
    try {
      await setStock.mutateAsync({ facilityId, quantity });
      toast.success('Stock actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const byFacility = new Map((stock.data ?? []).map((r) => [r.facilityId, r.quantity]));

  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Stock de {product?.name}</DialogTitle>
          <DialogDescription>
            Cuántas unidades hay en cada local. Las ventas lo descuentan solas y cancelar una venta
            lo devuelve.
          </DialogDescription>
        </DialogHeader>
        {facilities.isLoading || stock.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (facilities.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Primero crea un local.</p>
        ) : (
          <ul className="space-y-2">
            {(facilities.data ?? []).map((f) => {
              const current = byFacility.get(f.id) ?? 0;
              const value = values[f.id] ?? '0';
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    className="h-9 w-24"
                    aria-label={`Stock en ${f.name}`}
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setStock.isPending || Number(value) === current}
                    onClick={() => void save(f.id)}
                  >
                    Guardar
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
