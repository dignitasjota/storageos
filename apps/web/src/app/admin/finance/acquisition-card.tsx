'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { CsvButton } from '@/components/admin/metrics/csv-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useFinanceAcquisition,
  useMarketingSpend,
  useSetMarketingSpend,
} from '@/lib/admin/metrics-insights-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatEur, formatNumber, formatPct } from '@/lib/format';

/**
 * Coste de adquisición (comisiones de venta + marketing entre los clientes
 * nuevos que pagan) y meses que se tarda en recuperarlo.
 */
export function AcquisitionCard({ months }: { months: number }) {
  const q = useFinanceAcquisition(months);
  const spend = useMarketingSpend(months);
  const setSpend = useSetMarketingSpend();
  const canEdit = useIsSuperadmin();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const d = q.data;
  const spendBy = new Map((spend.data ?? []).map((r) => [r.month, r.amount]));

  async function save(month: string) {
    const raw = drafts[month];
    if (raw === undefined) return;
    const amount = Number(raw.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Escribe un importe válido.');
      return;
    }
    try {
      await setSpend.mutateAsync({ month, amount });
      setDrafts(({ [month]: _, ...rest }) => rest);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Coste de adquisición y recuperación</CardTitle>
          <CsvButton
            filename={`adquisicion-${months}m.csv`}
            disabled={!d}
            rows={() => [
              ['Mes', 'Nuevos que pagan', 'Comisiones de venta', 'Marketing', 'Coste por cliente'],
              ...(d?.monthly ?? []).map((m) => [
                m.label,
                m.newPaying,
                m.salesSpend,
                m.marketingSpend,
                m.cac ?? '',
              ]),
            ]}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Comisiones de venta de los comerciales del mes más el gasto de marketing, entre los
          clientes que pagaron por primera vez ese mes. Recuperación = coste por cliente / (ingreso
          medio por cliente × margen bruto).
          {canEdit && ' Escribe el gasto de marketing de cada mes en la tabla.'}
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Figure
                label="Coste por cliente nuevo"
                value={d.totals.cac === null ? '—' : formatEur(d.totals.cac)}
              />
              <Figure
                label="Meses para recuperarlo"
                value={d.paybackMonths === null ? '—' : formatNumber(d.paybackMonths, 1)}
              />
              <Figure label="Ingreso medio por cliente (sin IVA)" value={formatEur(d.arpa)} />
              <Figure
                label="Margen bruto"
                value={d.grossMarginPct === null ? '—' : formatPct(d.grossMarginPct)}
              />
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Mes</th>
                    <th className="p-2 text-right">Nuevos</th>
                    <th className="p-2 text-right">Ventas</th>
                    <th className="p-2 text-right">Marketing</th>
                    <th className="p-2 text-right">Por cliente</th>
                  </tr>
                </thead>
                <tbody>
                  {d.monthly.map((m) => (
                    <tr key={m.month} className="border-t">
                      <td className="whitespace-nowrap p-2">{m.label}</td>
                      <td className="p-2 text-right tabular-nums">{m.newPaying}</td>
                      <td className="p-2 text-right tabular-nums">{formatEur(m.salesSpend)}</td>
                      <td className="p-2 text-right">
                        {canEdit ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              className="h-7 w-20 text-right"
                              inputMode="decimal"
                              aria-label={`Marketing de ${m.label}`}
                              value={
                                drafts[m.month] ??
                                String(spendBy.get(m.month) ?? m.marketingSpend).replace('.', ',')
                              }
                              onChange={(e) =>
                                setDrafts((s) => ({ ...s, [m.month]: e.target.value }))
                              }
                              onKeyDown={(e) => e.key === 'Enter' && void save(m.month)}
                            />
                            {drafts[m.month] !== undefined && (
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => void save(m.month)}
                                disabled={setSpend.isPending}
                              >
                                Guardar
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="tabular-nums">{formatEur(m.marketingSpend)}</span>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {m.cac === null ? '—' : formatEur(m.cac)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
