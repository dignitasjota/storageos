'use client';

import { DASHBOARD_PERIOD_LABELS, type DashboardPeriodFiguresDto } from '@storageos/shared';
import Link from 'next/link';

import { Delta } from '@/app/(app)/analytics/period';
import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent } from '@/components/ui/card';
import { formatEur } from '@/lib/format';

const VS = 'vs el periodo anterior';

function Figure({
  label,
  value,
  current,
  previous,
  href,
  goodWhenUp = true,
}: {
  label: string;
  value: string;
  current: number;
  previous: number;
  href: string;
  goodWhenUp?: boolean;
}) {
  return (
    <Link href={href} className="block rounded-lg p-2 transition-colors hover:bg-muted/50">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs">
        <Delta current={current} previous={previous} goodWhenUp={goodWhenUp} suffix={VS} />
      </p>
    </Link>
  );
}

/** Lo que ha pasado en el periodo elegido, frente al anterior. */
export function PeriodStrip({
  data,
  loading,
  onRetry,
}: {
  data: DashboardPeriodFiguresDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-24">
          {(p) => (
            <>
              <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">
                {DASHBOARD_PERIOD_LABELS[p.period]}
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {p.moneyVisible && (
                  <>
                    <Figure
                      label="Cobrado"
                      value={formatEur(p.collected)}
                      current={p.collected}
                      previous={p.previous.collected}
                      href="/payments"
                    />
                    <Figure
                      label="Facturado"
                      value={formatEur(p.invoiced)}
                      current={p.invoiced}
                      previous={p.previous.invoiced}
                      href="/invoices"
                    />
                  </>
                )}
                <Figure
                  label="Altas"
                  value={String(p.moveIns)}
                  current={p.moveIns}
                  previous={p.previous.moveIns}
                  href="/contracts"
                />
                <Figure
                  label="Bajas"
                  value={String(p.moveOuts)}
                  current={p.moveOuts}
                  previous={p.previous.moveOuts}
                  href="/analytics?tab=churn"
                  goodWhenUp={false}
                />
                <Figure
                  label="Inquilinos nuevos"
                  value={String(p.newCustomers)}
                  current={p.newCustomers}
                  previous={p.previous.newCustomers}
                  href="/customers"
                />
              </div>
            </>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}
