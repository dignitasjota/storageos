'use client';

import { type UnitStatusValue } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOccupancyDashboard } from '@/lib/facilities/hooks';

const STATUS_LABELS: Record<UnitStatusValue, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

const STATUS_COLORS: Record<UnitStatusValue, string> = {
  available: '#64748b', // slate-500
  occupied: '#16a34a', // green-600
  reserved: '#eab308', // yellow-500
  maintenance: '#f97316', // orange-500
  blocked: '#dc2626', // red-600
};

export function OccupancyCard() {
  const dash = useOccupancyDashboard();

  if (dash.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ocupación</CardTitle>
        </CardHeader>
        <CardContent className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!dash.data || dash.data.totalUnits === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Ocupación</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Aún no hay trasteros creados. Cuando los añadas, verás aquí la ocupación en tiempo real.
          </p>
        </CardContent>
      </Card>
    );
  }

  const pieData = (Object.keys(STATUS_LABELS) as UnitStatusValue[])
    .map((status) => ({
      status,
      label: STATUS_LABELS[status],
      color: STATUS_COLORS[status],
      value: dash.data.byStatus[status] ?? 0,
    }))
    .filter((d) => d.value > 0);

  const occupiedPct = Math.round((dash.data.byStatus.occupied / dash.data.totalUnits) * 1000) / 10;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ocupación</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col items-center justify-center">
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  innerRadius={48}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="label"
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.status} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            <span className="text-xl font-semibold text-foreground tabular-nums">
              {occupiedPct}%
            </span>{' '}
            ocupado · {dash.data.totalUnits} trasteros
          </p>
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">Por estado</h4>
          <ul className="space-y-1 text-sm">
            {pieData.map((d) => (
              <li key={d.status} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block size-3 rounded-sm"
                    style={{ backgroundColor: d.color }}
                  />
                  {d.label}
                </span>
                <span className="font-mono tabular-nums">{d.value}</span>
              </li>
            ))}
          </ul>
          {dash.data.byFacility.length > 1 && (
            <div className="pt-2">
              <h4 className="mb-1 text-sm font-medium text-muted-foreground">Por local</h4>
              <ul className="space-y-1 text-sm">
                {dash.data.byFacility.map((f) => (
                  <li key={f.facilityId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{f.facilityName}</span>
                    <span className="font-mono tabular-nums">
                      {f.occupancyPct}% · {f.occupiedUnits}/{f.totalUnits}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
