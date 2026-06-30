'use client';

import { Loader2, ShoppingBag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PortalSessionDto, ProductDto, ProductSaleDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/auth/api';

function priceWithTax(p: ProductDto): number {
  return p.price * (1 + p.taxRate / 100);
}

export function ShopCard({
  session,
  onPurchased,
}: {
  session: PortalSessionDto;
  onPurchased: () => void;
}) {
  const [products, setProducts] = useState<ProductDto[] | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProductDto[]>('/portal/me/products', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setProducts(p);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  async function buy(product: ProductDto) {
    const quantity = qty[product.id] ?? 1;
    setBusyId(product.id);
    try {
      await apiFetch<ProductSaleDto>('/portal/me/purchases', {
        method: 'POST',
        json: { items: [{ productId: product.id, quantity }] },
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      toast.success('Compra realizada. Tienes una factura pendiente de pago.');
      setQty((q) => ({ ...q, [product.id]: 1 }));
      onPurchased();
      // Refresca el stock visible.
      const fresh = await apiFetch<ProductDto[]>('/portal/me/products', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      setProducts(fresh);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar la compra.');
    } finally {
      setBusyId(null);
    }
  }

  if (!products || products.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingBag className="h-5 w-5 text-muted-foreground" /> Tienda
        </CardTitle>
        <CardDescription>
          Candados, cajas y accesorios. Al comprar se emite una factura que puedes pagar aquí mismo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {products.map((p) => {
          const max = Math.min(p.totalStock, 99);
          const value = qty[p.id] ?? 1;
          return (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div className="text-sm">
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {priceWithTax(p).toFixed(2)} € (IVA incl.)
                  {p.description ? ` · ${p.description}` : ''} · {p.totalStock} disponibles
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={max}
                  value={value}
                  onChange={(e) => {
                    const n = Math.max(1, Math.min(max, Number(e.target.value) || 1));
                    setQty((q) => ({ ...q, [p.id]: n }));
                  }}
                  className="w-16"
                />
                <Button size="sm" onClick={() => buy(p)} disabled={busyId === p.id}>
                  {busyId === p.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  Comprar
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
