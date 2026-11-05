'use client';

import { type UnitStatusValue } from '@storageos/shared';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOccupancyDashboard } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';

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

interface OccupancyView {
  totalUnits: number;
  byStatus: Partial<Record<string, number>>;
  byFacility?: {
    facilityId: string;
    facilityName: string;
    occupancyPct: number;
    occupiedUnits: number;
    totalUnits: number;
  }[];
}

/** Para los roles que no ven las métricas: su propia ocupación, por local. */
export function OwnOccupancyCard() {
  const facilityId = useHeaderFacilityId();
  const dash = useOccupancyDashboard(facilityId);
  return (
    <OccupancyCard data={dash.data} loading={dash.isLoading} onRetry={() => void dash.refetch()} />
  );
}

export function OccupancyCard({
  data,
  loading,
  onRetry,
}: {
  data: OccupancyView | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card className={data?.totalUnits === 0 ? 'border-dashed' : undefined}>
      <CardHeader>
        <CardTitle className="text-base">Ocupación</CardTitle>
      </CardHeader>
      <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-48">
        {(view) =>
          view.totalUnits === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Aún no hay trasteros creados. Cuando los añadas, verás aquí la ocupación en tiempo
                real.
              </p>
            </CardContent>
          ) : (
            <OccupancyDetail view={view} />
          )
        }
      </SectionBody>
    </Card>
  );
}

function OccupancyDetail({ view }: { view: OccupancyView }) {
  const pieData = (Object.keys(STATUS_LABELS) as UnitStatusValue[])
    .map((status) => ({
      status,
      label: STATUS_LABELS[status],
      color: STATUS_COLORS[status],
      value: view.byStatus[status] ?? 0,
    }))
    .filter((d) => d.value > 0);

  const occupiedPct = Math.round(((view.byStatus.occupied ?? 0) / view.totalUnits) * 1000) / 10;

  return (
    <CardContent className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col items-center justify-center">
        <div className="h-48 w-full">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 300, height: 192 }}
          >
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
          <span className="text-xl font-semibold text-foreground tabular-nums">{occupiedPct}%</span>{' '}
          ocupado · {view.totalUnits} trasteros
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
        {view.byFacility && view.byFacility.length > 1 && (
          <div className="pt-2">
            <h4 className="mb-1 text-sm font-medium text-muted-foreground">Por local</h4>
            <ul className="space-y-1 text-sm">
              {view.byFacility.map((f) => (
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
  );
}
