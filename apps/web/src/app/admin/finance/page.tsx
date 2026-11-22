'use client';

import { Download, FileText, Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { AcquisitionCard } from './acquisition-card';
import { CashMonthCard } from './cash-month-card';
import { ForecastCard } from './forecast-card';
import { MarginCard } from './margin-card';
import { ReconciliationCard } from './reconciliation-card';
import { VatQuarterlyCard } from './vat-quarterly-card';

import type { AdminFinanceCsvKind } from '@storageos/shared';

import { ApplicationFeeReport } from '@/components/admin/application-fee-report';
import {
  annotationLines,
  useAnnotationsByLabel,
} from '@/components/admin/metrics/annotation-lines';
import { Delta, PeriodSelect } from '@/components/admin/period-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAdminFinance } from '@/lib/admin/hooks';
import { downloadFinanceCsv, downloadFinancePdf } from '@/lib/admin/metrics-insights-hooks';
import { formatCount, formatEur, formatEurShort } from '@/lib/format';

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  paypal: 'PayPal',
  other: 'Otro',
  manual: 'Manual',
  sepa: 'Remesa SEPA',
  redsys: 'Redsys (tarjeta o Bizum)',
};

/** Series del gráfico mensual: paleta categórica en orden fijo (1-4). */
const SOURCES = [
  { key: 'stripe', label: 'Stripe', color: '#2a78d6' },
  { key: 'sepa', label: 'Remesa SEPA', color: '#eb6834' },
  { key: 'redsys', label: 'Redsys', color: '#1baf7a' },
  { key: 'manual', label: 'A mano', color: '#eda100' },
] as const;

export default function AdminFinancePage() {
  const [months, setMonths] = useState(12);
  const [vat, setVat] = useState<'with' | 'without'>('with');
  const finance = useAdminFinance(months, vat);
  const notes = useAnnotationsByLabel();
  const d = finance.data;
  const vatText = vat === 'with' ? 'con IVA' : 'sin IVA';
  const [exporting, setExporting] = useState(false);

  async function exportFile(run: () => Promise<void>) {
    setExporting(true);
    try {
      await run();
    } catch {
      toast.error('No se pudo descargar.');
    } finally {
      setExporting(false);
    }
  }
  const csv = (kind: AdminFinanceCsvKind) => () =>
    void exportFile(() => downloadFinanceCsv(kind, { months, vat }));

  if (finance.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!d) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No hemos podido cargar las finanzas.
      </div>
    );
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Finanzas</h1>
          <p className="text-sm text-muted-foreground">
            Ingresos reales del SaaS por forma de cobro, descontado lo devuelto, reconciliación con
            lo facturado, margen y lo que se espera cobrar. Lo cobrado, devuelto y facturado va{' '}
            {vatText}; el MRR, el margen y la IA, sin IVA. Se actualiza cada minuto.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="IVA">
            {(
              [
                ['with', 'Con IVA'],
                ['without', 'Sin IVA'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                variant={vat === key ? 'secondary' : 'ghost'}
                className="h-8 px-3"
                aria-pressed={vat === key}
                onClick={() => setVat(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          <PeriodSelect value={months} onChange={setMonths} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={exporting}>
                {exporting ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Download className="mr-1 size-4" />
                )}
                Exportar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={csv('monthly')}>CSV: serie mensual</DropdownMenuItem>
              <DropdownMenuItem onSelect={csv('providers')}>
                CSV: por método de pago
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={csv('margin')}>CSV: margen</DropdownMenuItem>
              <DropdownMenuItem onSelect={csv('reconciliation')}>
                CSV: cobros y facturas que no cuadran
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void exportFile(() =>
                    downloadFinanceCsv('vat', { months, vat, year: new Date().getFullYear() }),
                  )
                }
              >
                CSV: IVA trimestral de este año
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void exportFile(() => downloadFinancePdf(months, vat))}
              >
                <FileText className="mr-2 size-4" /> Informe en PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label={`Cobrado neto, ${vatText} (${months} m)`}
          value={formatEur(d.collectedTotal)}
          hint={
            <>
              <Delta current={d.collectedTotal} previous={d.previous.collectedTotal} />
              <Delta
                current={d.collectedTotal}
                previous={d.lastYear.collectedTotal}
                against="lastYear"
              />
            </>
          }
        />
        <Kpi
          label={`Devuelto en el periodo, ${vatText} (${months} m)`}
          value={formatEur(d.refundedTotal)}
          hint={
            <>
              <Delta current={d.refundedTotal} previous={d.previous.refundedTotal} invert />
              <Delta
                current={d.refundedTotal}
                previous={d.lastYear.refundedTotal}
                invert
                against="lastYear"
              />
            </>
          }
        />
        <Kpi label={`En contracargo (${vatText})`} value={formatEur(d.disputedTotal)} />
        <Kpi label="MRR de los extras (sin IVA)" value={formatEur(d.addonsMrr)} />
        <Kpi
          label={`Facturado neto, ${vatText} (${months} m)`}
          value={formatEur(d.invoicedTotal)}
          hint={
            <>
              <Delta current={d.invoicedTotal} previous={d.previous.invoicedTotal} />
              <Delta
                current={d.invoicedTotal}
                previous={d.lastYear.invoicedTotal}
                against="lastYear"
              />
            </>
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SOURCES.map((src) => (
          <Kpi key={src.key} label={src.label} value={formatEur(d.bySource[src.key])} />
        ))}
      </div>

      <CashMonthCard />

      <ApplicationFeeReport months={months} />

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Asistente IA este mes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Pagan al mes por la IA (sin IVA)"
            value={formatEur(d.ai.revenueMonthly)}
            hint={
              <span className="text-xs text-muted-foreground">
                Extras del asistente y de consultas de los tenants que pagan
              </span>
            }
          />
          <Kpi
            label="Coste estimado (USD)"
            value={`${d.ai.costUsdThisMonth.toFixed(2).replace('.', ',')} $`}
            hint={<span className="text-xs text-muted-foreground">Con la IA de TrasterOS</span>}
          />
          <Kpi
            label="Consultas con la IA de TrasterOS"
            value={formatCount(d.ai.queriesThisMonth)}
          />
          <Kpi
            label="Consultas con la clave de cada tenant"
            value={formatCount(d.ai.ownKeyQueriesThisMonth)}
          />
        </CardContent>
      </Card>

      <ReconciliationCard r={d.reconciliation} />

      <ForecastCard />

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">
            Ingresos netos por mes y forma de cobro ({vatText})
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Cada cobro, en el mes en que se cobró y sin lo devuelto; lo devuelto, en el mes de la
            devolución.
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-72 w-full">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 288 }}
            >
              <BarChart data={d.monthly}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" fontSize={11} />
                <YAxis fontSize={11} width={52} tickFormatter={(v) => formatEurShort(Number(v))} />
                <Tooltip formatter={(v) => formatEur(Number(v) || 0)} />
                <Legend />
                {annotationLines(
                  notes,
                  d.monthly.map((m) => m.month),
                )}
                {SOURCES.map((src) => (
                  <Bar
                    key={src.key}
                    dataKey={src.key}
                    name={src.label}
                    stackId="a"
                    fill={src.color}
                    stroke="hsl(var(--background))"
                    strokeWidth={1}
                  />
                ))}
                <Bar
                  dataKey="refunded"
                  name="Devuelto"
                  fill="#dc2626"
                  stroke="hsl(var(--background))"
                  strokeWidth={1}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Cobrado neto por método de pago ({vatText})</CardTitle>
        </CardHeader>
        <CardContent>
          {d.byProvider.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin cobros en el periodo.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Método</th>
                    <th className="p-2 text-right">Nº pagos</th>
                    <th className="p-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byProvider.map((p) => (
                    <tr key={p.provider} className="border-t">
                      <td className="p-2">{PROVIDER_LABELS[p.provider] ?? p.provider}</td>
                      <td className="p-2 text-right tabular-nums">{p.count}</td>
                      <td className="p-2 text-right tabular-nums font-medium">
                        {formatEur(p.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <MarginCard months={months} />
      <section className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
        <AcquisitionCard months={months} />
        <VatQuarterlyCard />
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <div className="mt-0.5">{hint}</div>}
    </div>
  );
}
