'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { downloadFinanceCsv, useVatQuarterly } from '@/lib/admin/metrics-insights-hooks';
import { formatEur, formatPct } from '@/lib/format';

/** IVA repercutido de las facturas de suscripción por trimestre, para la asesoría. */
export function VatQuarterlyCard() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const q = useVatQuarterly(year);
  const d = q.data;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">IVA repercutido por trimestre</CardTitle>
          <div className="flex items-center gap-1">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="h-8 w-24" aria-label="Año">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 5 }, (_, i) => thisYear - i).map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() =>
                downloadFinanceCsv('vat', { months: 12, vat: 'with', year }).catch(() =>
                  toast.error('No se pudo descargar.'),
                )
              }
            >
              <Download className="mr-1 size-3.5" /> CSV
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          De las facturas de suscripción emitidas (sin las sustituidas; las rectificativas restan),
          por trimestre natural en hora de España.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Trimestre</th>
                  <th className="p-2 text-right">Facturas</th>
                  <th className="p-2 text-right">Base</th>
                  <th className="p-2 text-right">Cuota de IVA</th>
                  <th className="p-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {d.quarters.map((qt) => (
                  <tr key={qt.quarter} className="border-t align-top">
                    <td className="whitespace-nowrap p-2">
                      {qt.label}
                      {qt.byRate.length > 1 && (
                        <span className="block text-xs text-muted-foreground">
                          {qt.byRate
                            .map((r) => `${formatPct(r.rate, 0)}: ${formatEur(r.tax)}`)
                            .join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">{qt.invoices}</td>
                    <td className="p-2 text-right tabular-nums">{formatEur(qt.base)}</td>
                    <td className="p-2 text-right tabular-nums">{formatEur(qt.tax)}</td>
                    <td className="p-2 text-right tabular-nums">{formatEur(qt.total)}</td>
                  </tr>
                ))}
                <tr className="border-t font-medium">
                  <td className="p-2">Total {d.year}</td>
                  <td className="p-2 text-right tabular-nums">{d.totals.invoices}</td>
                  <td className="p-2 text-right tabular-nums">{formatEur(d.totals.base)}</td>
                  <td className="p-2 text-right tabular-nums">{formatEur(d.totals.tax)}</td>
                  <td className="p-2 text-right tabular-nums">{formatEur(d.totals.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
