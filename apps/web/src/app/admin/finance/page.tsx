'use client';

import { Loader2 } from 'lucide-react';
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
};

export default function AdminFinancePage() {
  const finance = useAdminFinance(12);
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Finanzas</h1>
        <p className="text-sm text-muted-foreground">
          Ingresos reales del SaaS por fuente (últimos 12 meses) y reconciliación con lo facturado.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Cobrado (12 m)" value={eur(d.collectedTotal)} />
        <Kpi label="Por Stripe" value={eur(d.stripeTotal)} />
        <Kpi label="Manual" value={eur(d.manualTotal)} />
        <Kpi label="MRR add-ons" value={eur(d.addonsMrr)} />
        <Kpi label="Facturado (12 m)" value={eur(d.invoicedTotal)} />
      </div>

      {!reconciled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          ⚠ El cobrado ({eur(d.collectedTotal)}) y el facturado ({eur(d.invoicedTotal)}) no cuadran.
          Puede ser normal (pagos sin factura emitida, o facturas de periodos distintos), pero
          revísalo.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingresos mensuales por fuente</CardTitle>
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
                <Bar dataKey="stripe" name="Stripe" stackId="a" fill="#6366f1" />
                <Bar dataKey="manual" name="Manual" stackId="a" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cobrado por método de pago</CardTitle>
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

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
