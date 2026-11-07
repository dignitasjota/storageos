'use client';

import {
  INVOICE_TAX_CATEGORY_LABELS,
  type CreateInvoiceItemInput,
  type InvoiceItemDto,
  type InvoiceTaxCategory,
} from '@storageos/shared';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatEur } from '@/lib/format';
import { useProducts } from '@/lib/products/hooks';

/** Tipo fiscal de una línea al 0 %: exenta o no sujeta (con IVA, siempre `S1`). */
type ZeroRateCategory = Exclude<InvoiceTaxCategory, 'S1'>;

const ZERO_RATE_OPTIONS: { value: ZeroRateCategory; label: string }[] = [
  { value: 'N1', label: 'No sujeta (fianza, indemnización)' },
  { value: 'E1', label: 'Exenta art. 20 (p. ej. alquiler de vivienda)' },
  { value: 'E6', label: 'Exenta (otros)' },
];

export interface InvoiceLineDraft {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  /** Solo cuenta al 0 %. */
  zeroCategory: ZeroRateCategory;
}

export const EMPTY_INVOICE_LINE: InvoiceLineDraft = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  taxRate: 21,
  zeroCategory: 'N1',
};

export function invoiceLineTotal(it: { quantity: number; unitPrice: number; taxRate: number }) {
  const base = Math.round(it.quantity * it.unitPrice * 100);
  return (base + Math.round((base * it.taxRate) / 100)) / 100;
}

export function invoiceLinesTotal(items: InvoiceLineDraft[]): number {
  return Math.round(items.reduce((sum, it) => sum + invoiceLineTotal(it), 0) * 100) / 100;
}

/** Alguna línea sin concepto, sin cantidad o sin precio. */
export function invoiceLinesInvalid(items: InvoiceLineDraft[]): boolean {
  return (
    items.length === 0 ||
    items.some((it) => !it.description.trim() || !(it.quantity > 0) || !(it.unitPrice > 0))
  );
}

/** Las líneas de una factura, para editarlas. */
export function invoiceLinesFrom(items: InvoiceItemDto[]): InvoiceLineDraft[] {
  if (items.length === 0) return [{ ...EMPTY_INVOICE_LINE }];
  return items.map((it) => ({
    description: it.description,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    taxRate: it.taxRate,
    zeroCategory: it.taxCategory === 'S1' ? 'N1' : it.taxCategory,
  }));
}

/** Lo que se manda al API. */
export function invoiceLinesInput(items: InvoiceLineDraft[]): CreateInvoiceItemInput[] {
  return items.map((it) => ({
    description: it.description.trim(),
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    taxRate: it.taxRate,
    taxCategory: it.taxRate === 0 ? it.zeroCategory : 'S1',
  }));
}

/**
 * Líneas de una factura: concepto, cantidad, precio sin IVA e IVA; al 0 %, si
 * es exenta o no sujeta. Con `catalog`, se pueden añadir productos del catálogo
 * (solo el concepto y el precio: para vender con stock, Productos → Ventas).
 */
export function InvoiceLinesEditor({
  items,
  onChange,
  catalog = false,
}: {
  items: InvoiceLineDraft[];
  onChange: (items: InvoiceLineDraft[]) => void;
  catalog?: boolean;
}) {
  const products = useProducts({ isActive: true });
  const catalogItems = catalog ? (products.data ?? []) : [];
  const total = invoiceLinesTotal(items);

  const update = (idx: number, patch: Partial<InvoiceLineDraft>) =>
    onChange(items.map((row, i) => (i === idx ? { ...row, ...patch } : row)));

  function addProduct(productId: string): void {
    const p = catalogItems.find((x) => x.id === productId);
    if (!p) return;
    const line: InvoiceLineDraft = {
      description: p.name,
      quantity: 1,
      unitPrice: p.price,
      taxRate: p.taxRate,
      zeroCategory: 'N1',
    };
    // Si solo hay una línea vacía, la sustituye.
    const onlyEmpty =
      items.length === 1 && !items[0]?.description.trim() && !(items[0]?.unitPrice ?? 0);
    onChange(onlyEmpty ? [line] : [...items, line]);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Líneas</Label>
        <div className="flex flex-wrap gap-2">
          {catalogItems.length > 0 && (
            <Select value="" onValueChange={addProduct}>
              <SelectTrigger className="h-8 w-[200px] text-xs" aria-label="Añadir del catálogo">
                <SelectValue placeholder="Añadir del catálogo" />
              </SelectTrigger>
              <SelectContent>
                {catalogItems.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {formatEur(p.price)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([...items, { ...EMPTY_INVOICE_LINE }])}
          >
            <Plus className="mr-1 h-3 w-3" /> Añadir línea
          </Button>
        </div>
      </div>
      <ul className="space-y-3">
        {items.map((it, idx) => {
          const zeroOptions = ZERO_RATE_OPTIONS.some((o) => o.value === it.zeroCategory)
            ? ZERO_RATE_OPTIONS
            : [
                ...ZERO_RATE_OPTIONS,
                { value: it.zeroCategory, label: INVOICE_TAX_CATEGORY_LABELS[it.zeroCategory] },
              ];
          return (
            <li key={idx} className="space-y-2 rounded border p-2">
              <div className="flex gap-2">
                <Input
                  aria-label="Concepto"
                  placeholder="Concepto"
                  value={it.description}
                  onChange={(e) => update(idx, { description: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Quitar línea"
                  disabled={items.length === 1}
                  onClick={() => onChange(items.filter((_row, i) => i !== idx))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Cantidad</Label>
                  <Input
                    type="number"
                    step="1"
                    min="1"
                    inputMode="numeric"
                    value={it.quantity}
                    onChange={(e) => update(idx, { quantity: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Precio sin IVA (€)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={it.unitPrice}
                    onChange={(e) => update(idx, { unitPrice: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">IVA (%)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    inputMode="decimal"
                    value={it.taxRate}
                    onChange={(e) => update(idx, { taxRate: Number(e.target.value) })}
                  />
                </div>
              </div>
              {it.taxRate === 0 && (
                <Select
                  value={it.zeroCategory}
                  onValueChange={(v) => update(idx, { zeroCategory: v as ZeroRateCategory })}
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Tipo de operación">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {zeroOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {it.description.trim() && !(it.unitPrice > 0) && (
                <p className="text-xs text-destructive">
                  El precio tiene que ser mayor que 0. Para restar, rectifica la factura.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {catalog && catalogItems.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Del catálogo se toma el concepto y el precio; no se descuenta stock (para eso, Productos →
          Ventas).
        </p>
      )}
      <p className="text-right text-sm tabular-nums">
        Total con IVA: <span className="font-semibold">{formatEur(total)}</span>
      </p>
    </div>
  );
}
