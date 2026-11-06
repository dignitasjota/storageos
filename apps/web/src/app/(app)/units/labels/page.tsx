'use client';

import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { UNIT_LABELS_KEY } from '@/components/units/bulk-actions-bar';
import { useUnits } from '@/lib/facilities/hooks';
import { formatNumber } from '@/lib/format';

function readIds(): string[] {
  const one = new URLSearchParams(window.location.search).get('id');
  if (one) return [one];
  try {
    return JSON.parse(sessionStorage.getItem(UNIT_LABELS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Etiquetas de puerta: el código grande y un QR que abre la ficha del trastero. */
export default function UnitLabelsPage() {
  const [ids, setIds] = useState<string[]>([]);
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setIds(readIds());
    setOrigin(window.location.origin);
  }, []);
  const units = useUnits();
  const labels = useMemo(() => {
    const wanted = new Set(ids);
    return (units.data?.items ?? []).filter((u) => wanted.has(u.id));
  }, [units.data?.items, ids]);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      {/* Al imprimir solo sale la hoja de etiquetas, sin el menú ni la cabecera. */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .unit-labels, .unit-labels * { visibility: visible; }
          .unit-labels { position: absolute; inset: 0; }
          .unit-label { break-inside: avoid; }
        }
      `}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/units">
              <ArrowLeft className="mr-1 h-4 w-4" /> Trasteros
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Etiquetas de puerta</h1>
          <p className="text-sm text-muted-foreground">
            {labels.length} etiqueta(s). El QR abre la ficha del trastero en el móvil de tu equipo.
          </p>
        </div>
        <Button onClick={() => window.print()} disabled={labels.length === 0}>
          <Printer className="mr-1 h-4 w-4" /> Imprimir
        </Button>
      </div>
      {labels.length === 0 && !units.isLoading && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Selecciona trasteros en la lista y pulsa «Etiquetas».
        </p>
      )}
      <div className="unit-labels grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-2">
        {labels.map((u) => (
          <div
            key={u.id}
            className="unit-label flex items-center gap-4 rounded-lg border bg-white p-4 text-black"
          >
            <QRCodeSVG value={`${origin}/units/${u.id}`} size={96} />
            <div className="min-w-0">
              <p className="truncate text-4xl font-bold">{u.code}</p>
              <p className="truncate text-sm">{u.facilityName}</p>
              <p className="text-sm">
                {u.unitTypeName} · {formatNumber(u.areaM2, 1)} m²
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
