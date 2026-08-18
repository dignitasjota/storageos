'use client';

import {
  STORAGE_ITEMS,
  STORAGE_ITEM_CATEGORY_LABELS,
  computeStorageM2,
  recommendStorageUnit,
  type PublicLandingDto,
  type StorageItemCategory,
} from '@storageos/shared';
import { Calculator, Minus, Plus, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

const CATEGORY_ORDER: StorageItemCategory[] = ['muebles', 'electrodomesticos', 'cajas', 'otros'];

function formatPrice(n: number): string {
  return n.toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

/**
 * Calculadora de espacio (gratis en toda web `/s/[slug]`): el visitante elige
 * qué va a guardar → m² en vivo → le recomendamos el trastero real que le encaja
 * con su precio + CTA a reservar.
 */
export function StorageCalculator({ data, brand }: { data: PublicLandingDto; brand: string }) {
  const [qty, setQty] = useState<Record<string, number>>({});

  const m2 = useMemo(() => computeStorageM2(qty), [qty]);

  // Tipos disponibles con área, deduplicados por nombre (el menor precio/área).
  const unitTypes = useMemo(() => {
    const map = new Map<
      string,
      { name: string; areaM2: number | null; priceMonthly: number; available: number }
    >();
    for (const f of data.facilities) {
      for (const t of f.unitTypes) {
        const prev = map.get(t.name);
        if (!prev || (t.areaM2 ?? Infinity) < (prev.areaM2 ?? Infinity)) {
          map.set(t.name, {
            name: t.name,
            areaM2: t.areaM2,
            priceMonthly: t.priceMonthly,
            available: (prev?.available ?? 0) + t.available,
          });
        } else {
          prev.available += t.available;
        }
      }
    }
    return [...map.values()];
  }, [data.facilities]);

  const recommendation = useMemo(
    () => (m2 > 0 ? recommendStorageUnit(m2, unitTypes) : null),
    [m2, unitTypes],
  );

  function change(key: string, delta: number) {
    setQty((q) => {
      const next = Math.max(0, (q[key] ?? 0) + delta);
      const copy = { ...q };
      if (next === 0) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }

  const hasItems = m2 > 0;

  return (
    <section id="calculadora" className="mt-14 scroll-mt-20">
      <div className="mb-6 text-center">
        <h2 className="flex items-center justify-center gap-2 text-2xl font-bold tracking-tight">
          <Calculator className="h-6 w-6" style={{ color: brand }} />
          ¿Qué trastero necesitas?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Marca lo que vas a guardar y te decimos el tamaño ideal.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Selección de objetos */}
        <div className="space-y-5 lg:col-span-2">
          {CATEGORY_ORDER.map((cat) => (
            <div key={cat}>
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
                {STORAGE_ITEM_CATEGORY_LABELS[cat]}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {STORAGE_ITEMS.filter((i) => i.category === cat).map((item) => {
                  const count = qty[item.key] ?? 0;
                  return (
                    <div
                      key={item.key}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                        count > 0 ? 'border-foreground/30 bg-accent/40' : ''
                      }`}
                    >
                      <span>{item.label}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label={`Quitar ${item.label}`}
                          onClick={() => change(item.key, -1)}
                          disabled={count === 0}
                          className="flex h-7 w-7 items-center justify-center rounded-md border disabled:opacity-40"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-5 text-center font-medium tabular-nums">{count}</span>
                        <button
                          type="button"
                          aria-label={`Añadir ${item.label}`}
                          onClick={() => change(item.key, 1)}
                          className="flex h-7 w-7 items-center justify-center rounded-md border"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Resultado (sticky en escritorio) */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-lg border bg-card p-6 text-center shadow-sm">
            <p className="text-sm text-muted-foreground">Espacio necesario</p>
            <p className="mt-1 text-4xl font-bold tabular-nums" style={{ color: brand }}>
              {m2.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              <span className="ml-1 text-lg font-normal text-muted-foreground">m²</span>
            </p>

            {!hasItems ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Empieza a añadir objetos para ver tu trastero ideal.
              </p>
            ) : recommendation ? (
              <div className="mt-4 rounded-md border bg-background p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Te recomendamos
                </p>
                <p className="mt-1 text-lg font-semibold">{recommendation.name}</p>
                <p className="text-sm text-muted-foreground">
                  {recommendation.areaM2 != null ? `${recommendation.areaM2} m² · ` : ''}
                  desde {formatPrice(recommendation.priceMonthly * 1.21)}/mes
                </p>
                <Link
                  href={`/book/${data.tenantSlug}`}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md px-4 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
                  style={{ backgroundColor: brand }}
                >
                  Reservar este trastero
                </Link>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Contáctanos y te asesoramos con el tamaño ideal.
              </p>
            )}

            {hasItems && (
              <button
                type="button"
                onClick={() => setQty({})}
                className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" /> Empezar de nuevo
              </button>
            )}
            <p className="mt-4 text-[11px] leading-tight text-muted-foreground">
              Estimación orientativa. El espacio real depende de cómo se coloquen los objetos.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
