'use client';

import { Loader2 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { AdminError } from '@/components/admin/admin-error';
import { useUsageEvolution } from '@/lib/admin/health-insights-hooks';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} ${units[i]}`;
}

const num = (n: number) => n.toLocaleString('es-ES');
const usd = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

/**
 * Evolución mensual del uso (de todos o de un tenant): correos, WhatsApp e IA
 * por mes y el almacenamiento con su previsión por tendencia a 6 meses.
 */
export function UsageEvolution({
  tenantId,
  months = 12,
}: {
  tenantId: string | null;
  months?: number;
}) {
  const q = useUsageEvolution(tenantId, months);
  if (q.isError) return <AdminError onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const d = q.data;
  const usage = d.months.map((m) => ({
    label: m.label,
    Correos: m.emails,
    WhatsApp: m.whatsapp,
    'Llamadas a la IA': m.aiCalls,
  }));
  const storage = [
    ...d.months.map((m) => ({
      label: m.label,
      medido: m.storageBytes,
      previsto: null as number | null,
    })),
    ...d.storageForecast.map((f) => ({ label: f.label, medido: null, previsto: f.bytes })),
  ];
  // La línea prevista arranca en el último mes medido.
  const lastMeasured = [...d.months].reverse().find((m) => m.storageBytes !== null);
  if (lastMeasured) {
    const i = storage.findIndex((s) => s.label === lastMeasured.label);
    if (i >= 0) storage[i]!.previsto = lastMeasured.storageBytes;
  }
  const aiCost = d.months.reduce((a, m) => a + m.aiCostUsd, 0);

  return (
    <div className="space-y-4">
      <div className="h-56 w-full min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 300, height: 224 }}
        >
          <BarChart data={usage} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={44} />
            <Tooltip formatter={(v) => num(Number(v))} labelClassName="text-xs" />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Correos" fill="#2563eb" />
            <Bar dataKey="WhatsApp" fill="#16a34a" />
            <Bar dataKey="Llamadas a la IA" fill="#d97706" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        Coste estimado de la IA en los {d.months.length} meses: {usd(aiCost)} (sin las claves
        propias).
      </p>
      <div className="h-48 w-full min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 300, height: 192 }}
        >
          <LineChart data={storage} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis
              tick={{ fontSize: 11 }}
              width={60}
              tickFormatter={(v) => formatBytes(Number(v))}
            />
            <Tooltip
              formatter={(v) => (v === null ? '—' : formatBytes(Number(v)))}
              labelClassName="text-xs"
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="medido"
              name="Almacenamiento"
              stroke="#7c3aed"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="previsto"
              name="Previsión"
              stroke="#7c3aed"
              strokeDasharray="5 4"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        {d.storageForecast.length === 0
          ? 'Aún no hay mediciones del almacenamiento: se guarda una por mes al medir.'
          : `${
              d.storageMonthlyGrowth !== null
                ? `Crece ${formatBytes(Math.max(0, d.storageMonthlyGrowth))} al mes de media. `
                : ''
            }Si sigue así, en 6 meses ocupará ${formatBytes(
              d.storageForecast[d.storageForecast.length - 1]!.bytes,
            )} (tendencia de los últimos meses medidos).`}
      </p>
    </div>
  );
}
