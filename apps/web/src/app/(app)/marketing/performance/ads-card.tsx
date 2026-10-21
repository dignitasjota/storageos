'use client';

import { type AdPerformanceRowDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdsPerformance } from '@/lib/marketing/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const int = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const pct = (r: number | null) =>
  r == null ? '—' : `${(r * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
const money = (n: number | null) => (n == null ? '—' : eur(n));

const PLATFORM_LABELS = { google_ads: 'Google Ads', meta_ads: 'Meta Ads' } as const;

function lastData(row: AdPerformanceRowDto): string {
  if (!row.lastDataDate) {
    return row.externalCampaignId ? 'Sin datos todavía' : 'Sin campaña vinculada';
  }
  const [y, m, d] = row.lastDataDate.split('-').map(Number);
  return `Datos hasta el ${new Date(y!, m! - 1, d!).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
  })}`;
}

/** Rendimiento de las campañas de anuncios: lo que da la plataforma + lo que pasa después. */
export function AdsPerformanceCard({ range }: { range: { from: string; to: string } }) {
  const q = useAdsPerformance(range);
  const rows = q.data?.rows ?? [];
  const t = q.data?.totals;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Anuncios</CardTitle>
        <CardDescription>
          Impresiones, clics y conversiones de Google Ads y Meta Ads, y los contactos y reservas que
          llegaron después con el origen de cada campaña.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No hay canales de Google Ads ni Meta Ads. Conecta tu cuenta y vincula cada canal a su
            campaña en{' '}
            <Link href="/marketing/channels" className="text-primary hover:underline">
              Canales
            </Link>
            .
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Campaña</th>
                  <th className="px-2 py-2 text-right font-medium">Impresiones</th>
                  <th className="px-2 py-2 text-right font-medium">Clics</th>
                  <th className="px-2 py-2 text-right font-medium">CTR</th>
                  <th className="px-2 py-2 text-right font-medium">Coste/clic</th>
                  <th className="px-2 py-2 text-right font-medium">Gasto</th>
                  <th
                    className="px-2 py-2 text-right font-medium"
                    title="Las que cuenta Google Ads o Meta Ads"
                  >
                    Conversiones
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Contactos</th>
                  <th className="px-2 py-2 text-right font-medium">Reservas</th>
                  <th className="px-2 py-2 text-right font-medium">Coste/reserva</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.channelId} className="border-b last:border-0">
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.channelName}</span>
                        <Badge variant="outline" className="font-normal">
                          {PLATFORM_LABELS[r.platform]}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{lastData(r)}</div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(r.impressions)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(r.clicks)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{pct(r.ctr)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.cpc)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{eur(r.cost)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {int(r.platformConversions)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(r.contacts)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(r.bookings)}</td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">
                      {money(r.costPerBooking)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {t && rows.length > 1 && (
                <tfoot>
                  <tr className="border-t font-medium">
                    <td className="px-2 py-2">Total</td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(t.impressions)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(t.clicks)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{pct(t.ctr)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(t.cpc)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{eur(t.cost)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {int(t.platformConversions)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(t.contacts)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(t.bookings)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(t.costPerBooking)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Las <strong>conversiones</strong> son las que cuenta cada plataforma; los{' '}
          <strong>contactos</strong> y las <strong>reservas</strong> son los que llegaron a
          TrasterOS con el origen de la campaña (su «origen UTM» en el canal), así que el coste por
          reserva es el real. Los datos se actualizan cada mañana.
        </p>
      </CardContent>
    </Card>
  );
}
