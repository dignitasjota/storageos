'use client';

import { ArrowLeftRight } from 'lucide-react';
import Link from 'next/link';

import type { DashboardMoveDto, DashboardMovesDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDate } from '@/lib/format';

function Group({ title, rows }: { title: string; rows: DashboardMoveDto[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="divide-y text-sm">
        {rows.map((r) => (
          <li key={`${title}-${r.contractId}`}>
            <Link
              href={`/contracts/${r.contractId}`}
              className="flex items-center justify-between gap-2 py-1.5 hover:underline"
            >
              <span className="min-w-0 truncate">
                {r.customerName} <span className="text-muted-foreground">· {r.unitCode}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatDate(r.date)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => (
  <p className="py-8 text-center text-sm text-muted-foreground">{text}</p>
);

/** Quién ha entrado y salido en el periodo, y lo que viene. */
export function MovesCard({
  data,
  loading,
  onRetry,
}: {
  data: DashboardMovesDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowLeftRight className="size-4 text-violet-500" />
          Movimiento
        </CardTitle>
        <CardDescription>Entradas y salidas de inquilinos.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {(m) => (
            <Tabs defaultValue="upcoming">
              <TabsList className="mb-3">
                <TabsTrigger value="upcoming">Próximos 30 días</TabsTrigger>
                <TabsTrigger value="done">En el periodo</TabsTrigger>
              </TabsList>
              <TabsContent value="upcoming" className="space-y-3">
                {m.upcomingMoveIns.length + m.upcomingMoveOuts.length + m.expiring.length === 0 ? (
                  <Empty text="Nada previsto en los próximos 30 días." />
                ) : (
                  <>
                    <Group title="Entran" rows={m.upcomingMoveIns} />
                    <Group title="Salen" rows={m.upcomingMoveOuts} />
                    <Group title="Vencen sin renovación automática" rows={m.expiring} />
                  </>
                )}
              </TabsContent>
              <TabsContent value="done" className="space-y-3">
                {m.moveIns.length + m.moveOuts.length === 0 ? (
                  <Empty text="Sin altas ni bajas en este periodo." />
                ) : (
                  <>
                    <Group title="Altas" rows={m.moveIns} />
                    <Group title="Bajas" rows={m.moveOuts} />
                  </>
                )}
              </TabsContent>
            </Tabs>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}
