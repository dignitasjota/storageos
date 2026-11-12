'use client';

import { Download, FileDown, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CashClosureDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { MonthYearSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { downloadClosurePdf, useCashClosures } from '@/lib/cash/hooks';
import { downloadCsv } from '@/lib/csv';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';

const ALL = 'all';
const GLOBAL = 'global';

/**
 * Historial de cierres: los últimos o los de un mes, de todas las cajas o de
 * una, con la diferencia acumulada y el CSV del mes para la gestoría.
 */
export function ClosuresHistory({
  companyWide,
  facilities,
}: {
  companyWide: boolean;
  facilities: { id: string; name: string }[];
}) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [caja, setCaja] = useState<string>(ALL);
  const closures = useCashClosures({
    ...(month ? { month } : {}),
    ...(caja !== ALL ? { facilityId: caja } : {}),
  });
  const [pdfFor, setPdfFor] = useState<string | null>(null);
  const rows = closures.data ?? [];
  // La diferencia acumulada cuenta solo los cierres vigentes (no los reabiertos).
  const live = rows.filter((c) => !c.reopenedAt);
  const totals = live.reduce(
    (t, c) => ({
      expected: t.expected + Math.round(c.expectedCash * 100),
      counted: t.counted + Math.round(c.countedCash * 100),
      difference: t.difference + Math.round(c.difference * 100),
    }),
    { expected: 0, counted: 0, difference: 0 },
  );

  async function pdf(c: CashClosureDto) {
    setPdfFor(c.id);
    try {
      await downloadClosurePdf(c);
    } catch {
      toast.error('No se pudo generar el PDF del cierre.');
    } finally {
      setPdfFor(null);
    }
  }

  function exportCsv() {
    downloadCsv(`cierres-de-caja${month ? `-${month}` : ''}.csv`, [
      [
        'Día',
        'Caja',
        'Esperado (€)',
        'Contado (€)',
        'Diferencia (€)',
        'Cerrada por',
        'Estado',
        'Notas',
      ],
      ...rows.map((c) => [
        formatDate(c.date),
        c.facilityName ?? 'Toda la empresa',
        c.expectedCash,
        c.countedCash,
        c.difference,
        c.closedByName ?? '',
        c.reopenedAt ? `Reabierto: ${c.reopenReason ?? ''}` : 'Vigente',
        c.notes ?? '',
      ]),
    ]);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0 pb-2">
        <CardTitle className="text-base">
          {month ? 'Cierres del mes' : 'Cierres recientes'}
        </CardTitle>
        <div className="flex flex-wrap items-end gap-2">
          <MonthYearSelect value={month} onChange={setMonth} />
          {month && (
            <Button variant="ghost" size="sm" onClick={() => setMonth(undefined)}>
              Últimos
            </Button>
          )}
          <Select value={caja} onValueChange={setCaja}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas las cajas</SelectItem>
              {companyWide && <SelectItem value={GLOBAL}>Toda la empresa</SelectItem>}
              {facilities.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {rows.length > 0 && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="mr-1 size-4" /> CSV
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {closures.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : closures.isError ? (
          <SectionError onRetry={() => void closures.refetch()} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {month ? 'Ningún cierre en ese mes.' : 'Aún no hay cierres.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1">Día</th>
                  <th className="py-1">Caja</th>
                  <th className="py-1 text-right">Esperado</th>
                  <th className="py-1 text-right">Contado</th>
                  <th className="py-1 text-right">Diferencia</th>
                  <th className="py-1 pl-3">Cierre</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={`border-t ${c.reopenedAt ? 'opacity-70' : ''}`}>
                    <td className="py-1.5 align-top">
                      {formatDate(c.date)}
                      {c.reopenedAt && (
                        <Badge variant="outline" className="ml-1">
                          Reabierto
                        </Badge>
                      )}
                    </td>
                    <td className="py-1.5 align-top text-muted-foreground">
                      {c.facilityName ?? 'Toda la empresa'}
                    </td>
                    <td className="py-1.5 text-right align-top tabular-nums">
                      {formatEur(c.expectedCash)}
                    </td>
                    <td className="py-1.5 text-right align-top tabular-nums">
                      {formatEur(c.countedCash)}
                    </td>
                    <td
                      className={`py-1.5 text-right align-top tabular-nums ${
                        c.difference === 0 ? '' : 'text-destructive'
                      }`}
                    >
                      {formatEur(c.difference)}
                    </td>
                    <td className="py-1.5 pl-3 align-top text-xs text-muted-foreground">
                      {c.closedByName ?? '—'} · {formatDateTime(c.closedAt)}
                      {c.notes && <p className="text-foreground">{c.notes}</p>}
                      {c.reopenedAt && (
                        <p>
                          Reabierto por {c.reopenedByName ?? '—'} el {formatDateTime(c.reopenedAt)}:{' '}
                          {c.reopenReason}
                        </p>
                      )}
                    </td>
                    <td className="py-1.5 text-right align-top">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Descargar el cierre en PDF"
                        title="Descargar en PDF"
                        disabled={pdfFor === c.id}
                        onClick={() => void pdf(c)}
                      >
                        {pdfFor === c.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <FileDown className="size-3.5" />
                        )}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {live.length > 1 && (
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-1.5" colSpan={2}>
                      Total ({live.length} {live.length === 1 ? 'cierre' : 'cierres'})
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatEur(totals.expected / 100)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatEur(totals.counted / 100)}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${totals.difference === 0 ? '' : 'text-destructive'}`}
                    >
                      {formatEur(totals.difference / 100)}
                    </td>
                    <td
                      colSpan={2}
                      className="py-1.5 pl-3 text-xs font-normal text-muted-foreground"
                    >
                      Diferencia acumulada (sin los reabiertos)
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
