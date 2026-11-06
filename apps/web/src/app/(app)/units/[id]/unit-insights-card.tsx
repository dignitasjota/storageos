'use client';

import Link from 'next/link';

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useUnitInsights } from '@/lib/facilities/inventory-hooks';
import { formatDate, formatEur } from '@/lib/format';

const CONTRACT_STATUS: Record<string, string> = {
  active: 'En vigor',
  ending: 'Baja pedida',
  ended: 'Terminado',
  cancelled: 'Cancelado',
  draft: 'Borrador',
};

/** Rentabilidad e inquilinos que ha tenido el trastero. */
export function UnitInsightsCard({ unitId }: { unitId: string }) {
  const insights = useUnitInsights(unitId);
  const { data } = insights;
  if (insights.isError) return <SectionError onRetry={() => void insights.refetch()} />;
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Metric
          label="Libre desde hace"
          value={data.daysVacant === null ? '—' : `${data.daysVacant} días`}
        />
        <Metric
          label="Alquilado el último año"
          value={`${Math.round((data.daysRentedLastYear / data.daysTrackedLastYear) * 100)} %`}
          hint={`${data.daysRentedLastYear} de ${data.daysTrackedLastYear} días`}
        />
        <Metric
          label="Facturado en 12 meses"
          value={formatEur(data.revenue12m)}
          hint="Sin IVA ni fianzas"
        />
        <Metric
          label="Por m² en 12 meses"
          value={data.revenuePerM2 === null ? '—' : formatEur(data.revenuePerM2)}
          hint="Sin IVA ni fianzas"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inquilinos que ha tenido</CardTitle>
        </CardHeader>
        <CardContent>
          {data.tenancies.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no ha tenido contratos.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.tenancies.map((t) => (
                <li
                  key={`${t.contractId}-${t.startDate}`}
                  className="flex flex-wrap justify-between gap-2 border-b pb-2 last:border-0"
                >
                  <span>
                    <Link
                      href={`/customers/${t.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {t.customerName}
                    </Link>{' '}
                    ·{' '}
                    <Link href={`/contracts/${t.contractId}`} className="hover:underline">
                      {t.contractNumber}
                    </Link>
                    <span className="block text-muted-foreground">
                      {formatDate(t.startDate)} → {t.endDate ? formatDate(t.endDate) : 'hoy'} ·{' '}
                      {t.movedAway ? 'Se trasladó' : (CONTRACT_STATUS[t.status] ?? t.status)}
                    </span>
                  </span>
                  <span className="text-right">
                    {formatEur(t.priceMonthly)}/mes
                    <span className="block text-muted-foreground">
                      facturado {formatEur(t.invoiced)} sin IVA
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
