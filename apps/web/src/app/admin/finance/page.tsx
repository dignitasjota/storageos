'use client';

import { Loader2 } from 'lucide-react';
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

import { ForecastCard } from './forecast-card';

import { Delta, PeriodSelect } from '@/components/admin/period-select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminFinance } from '@/lib/admin/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

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
  const finance = useAdminFinance(months);
  const d = finance.data;

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

  const reconciled = Math.abs(d.collectedTotal - d.invoicedTotal) < 0.01;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Finanzas</h1>
          <p className="text-sm text-muted-foreground">
            Ingresos reales del SaaS por forma de cobro, descontado lo devuelto, reconciliación con
            lo facturado y lo que se espera cobrar.
          </p>
        </div>
        <PeriodSelect value={months} onChange={setMonths} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label={`Cobrado neto (${months} m)`}
          value={eur(d.collectedTotal)}
          hint={<Delta current={d.collectedTotal} previous={d.previous.collectedTotal} />}
        />
        <Kpi
          label={`Devuelto (${months} m)`}
          value={eur(d.refundedTotal)}
          hint={<Delta current={d.refundedTotal} previous={d.previous.refundedTotal} invert />}
        />
        <Kpi label="En contracargo" value={eur(d.disputedTotal)} />
        <Kpi label="MRR add-ons" value={eur(d.addonsMrr)} />
        <Kpi
          label={`Facturado neto (${months} m)`}
          value={eur(d.invoicedTotal)}
          hint={<Delta current={d.invoicedTotal} previous={d.previous.invoicedTotal} />}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SOURCES.map((src) => (
          <Kpi key={src.key} label={src.label} value={eur(d.bySource[src.key])} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Asistente IA este mes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Pagan al mes por la IA"
            value={eur(d.ai.revenueMonthly)}
            hint={
              <span className="text-xs text-muted-foreground">
                Extras del asistente y de consultas
              </span>
            }
          />
          <Kpi
            label="Coste estimado (USD)"
            value={d.ai.costUsdThisMonth.toLocaleString('es-ES', {
              style: 'currency',
              currency: 'USD',
            })}
            hint={<span className="text-xs text-muted-foreground">Con la IA de TrasterOS</span>}
          />
          <Kpi
            label="Consultas con la IA de TrasterOS"
            value={d.ai.queriesThisMonth.toLocaleString('es-ES')}
          />
          <Kpi
            label="Consultas con la clave de cada tenant"
            value={d.ai.ownKeyQueriesThisMonth.toLocaleString('es-ES')}
          />
        </CardContent>
      </Card>

      {!reconciled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          ⚠ El cobrado neto ({eur(d.collectedTotal)}) y el facturado neto ({eur(d.invoicedTotal)})
          no cuadran. Puede ser normal (pagos sin factura emitida, o facturas de periodos
          distintos), pero revísalo.
        </div>
      )}

      <ForecastCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingresos netos por mes y forma de cobro</CardTitle>
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
                <YAxis fontSize={11} />
                <Tooltip formatter={(v) => eur(Number(v) || 0)} />
                <Legend />
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
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cobrado neto por método de pago</CardTitle>
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
                      <td className="p-2 text-right tabular-nums font-medium">{eur(p.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <div className="mt-0.5">{hint}</div>}
    </div>
  );
}
