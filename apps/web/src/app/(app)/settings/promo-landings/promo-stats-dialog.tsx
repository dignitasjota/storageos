'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import type { PromoLandingDto } from '@storageos/shared';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePromoLandingStats } from '@/lib/promo-landings/hooks';

const PERIODS = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
  { days: 0, label: 'Todo' },
];

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Resultados de una landing: visitas por origen → reservas → firmadas → pagadas → ingresos. */
export function PromoStatsDialog({
  landing,
  onOpenChange,
}: {
  landing: PromoLandingDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [days, setDays] = useState(30);
  const stats = usePromoLandingStats(landing?.id ?? null, days);
  const s = stats.data;

  return (
    <Dialog open={!!landing} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Resultados · {landing?.name}</DialogTitle>
          <DialogDescription>
            Visitas a la landing y reservas online hechas desde ella. Los ingresos son lo cobrado en
            el primer pago de esas reservas (sin la fianza).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              onClick={() => setDays(p.days)}
              className={`rounded-full border px-3 py-1 text-sm ${
                days === p.days ? 'border-primary bg-primary text-primary-foreground' : ''
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {stats.isLoading || !s ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Visitas', s.visits.toLocaleString('es-ES'), `${s.visitors} visitantes`],
                ['Reservas', String(s.bookings), `${s.signed} firmadas`],
                [
                  'Pagadas',
                  String(s.paid),
                  s.conversionPct !== null
                    ? `${s.conversionPct.toLocaleString('es-ES')} % de los visitantes`
                    : '—',
                ],
                [
                  'Ingresos',
                  eur(s.revenue),
                  landing?.couponCode ? `${s.couponUses} con el cupón` : 'primer pago',
                ],
              ].map(([label, value, hint]) => (
                <div key={label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-xl font-semibold tabular-nums">{value}</p>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
              ))}
            </div>

            {s.bySource.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                Aún no hay visitas en este periodo.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 pr-3 font-medium">Origen</th>
                      <th className="py-2 pr-3 text-right font-medium">Visitas</th>
                      <th className="py-2 pr-3 text-right font-medium">Visitantes</th>
                      <th className="py-2 pr-3 text-right font-medium">Reservas</th>
                      <th className="py-2 pr-3 text-right font-medium">Pagadas</th>
                      <th className="py-2 text-right font-medium">Ingresos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.bySource.map((r) => (
                      <tr key={r.source} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-mono text-xs">{r.source}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.visits}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.visitors}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.bookings}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.paid}</td>
                        <td className="py-2 text-right tabular-nums">{eur(r.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
