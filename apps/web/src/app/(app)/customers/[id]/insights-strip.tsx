'use client';

import type { CustomerRiskLevel } from '@storageos/shared';

import { Card, CardContent } from '@/components/ui/card';
import { useCustomerInsights } from '@/lib/customers/features-hooks';
import { formatDate, formatEur } from '@/lib/format';

const RISK: Record<CustomerRiskLevel, { label: string; className: string }> = {
  low: { label: 'Bajo', className: 'text-emerald-700 dark:text-emerald-400' },
  medium: { label: 'Medio', className: 'text-amber-700 dark:text-amber-400' },
  high: { label: 'Alto', className: 'text-destructive' },
};

function tenure(months: number) {
  if (months < 1) return 'Menos de un mes';
  if (months < 12) return `${months} ${months === 1 ? 'mes' : 'meses'}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `${years} ${years === 1 ? 'año' : 'años'}${rest ? ` y ${rest} m` : ''}`;
}

function Fact(props: { label: string; value: string; hint?: string | null; className?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className={`font-medium ${props.className ?? ''}`}>{props.value}</p>
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

/** El inquilino de un vistazo: antigüedad, lo pagado y qué riesgo tiene. */
export function CustomerInsightsStrip({ customerId }: { customerId: string }) {
  const { data } = useCustomerInsights(customerId);
  if (!data) return null;
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 p-4 lg:grid-cols-4">
        <Fact
          label="Con nosotros"
          value={data.customerSince ? tenure(data.tenureMonths) : 'Sin contrato firmado'}
          hint={data.customerSince ? `Desde ${formatDate(data.customerSince)}` : null}
        />
        {data.paidTotal !== null && (
          <Fact
            label="Ha pagado"
            value={formatEur(data.paidTotal)}
            hint={`${formatEur(data.paid12m ?? 0)} en 12 meses`}
          />
        )}
        {data.churn && (
          <Fact
            label="Riesgo de baja"
            value={RISK[data.churn.level].label}
            className={RISK[data.churn.level].className}
            hint={data.churn.factors.slice(0, 2).join(' · ') || null}
          />
        )}
        {data.paymentRisk && (
          <Fact
            label="Riesgo de impago"
            value={RISK[data.paymentRisk.level].label}
            className={RISK[data.paymentRisk.level].className}
            hint={data.paymentRisk.reasons.slice(0, 2).join(' · ') || 'Paga a tiempo'}
          />
        )}
      </CardContent>
    </Card>
  );
}
