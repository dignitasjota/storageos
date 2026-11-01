'use client';

import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useQuoteOffers } from '@/lib/admin/hooks';

/** Conversión de las propuestas de cuota enviadas desde el simulador. */
export function QuoteOffersCard() {
  const q = useQuoteOffers();
  const s = q.data?.stats;
  if (!s || s.sent === 0) return null;
  const pending = s.sent - s.accepted - s.rejected;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Propuestas de cuota</CardTitle>
        <p className="text-xs text-muted-foreground">
          Enviadas desde el simulador en los últimos 90 días.{' '}
          <Link href="/admin/quote" className="underline">
            Ver propuestas
          </Link>
        </p>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Enviadas', String(s.sent)],
          ['Aceptadas', String(s.accepted)],
          ['Sin respuesta', String(pending)],
          ['Conversión', s.conversionPct == null ? '—' : `${s.conversionPct} %`],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
