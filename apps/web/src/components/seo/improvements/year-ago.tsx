'use client';

import { SeoChange } from '../seo-change';

import { formatCount, formatDate, formatNumber } from '@/lib/format';
import { useOpportunityYearAgo, type ImprovementScope } from '@/lib/seo-advanced/improvement-hooks';

/**
 * «Baja» o «Sube» frente al mismo periodo del año anterior (mejora 12): en un
 * negocio estacional evita falsas alarmas. Avisa si no hay histórico.
 */
export function OpportunityYearAgo({
  scope,
  opportunityId,
}: {
  scope: ImprovementScope;
  opportunityId: string;
}) {
  const data = useOpportunityYearAgo(scope, opportunityId);
  const d = data.data;
  if (data.isLoading || data.isError || !d) return null;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs font-medium text-muted-foreground">
        Frente al mismo periodo del año pasado
      </p>
      {!d.available || !d.yearAgo || !d.current ? (
        <p className="text-xs text-muted-foreground">{d.message}</p>
      ) : (
        <>
          <p>
            {formatDate(d.yearFrom)} – {formatDate(d.yearTo)}: {formatCount(d.yearAgo.impressions)}{' '}
            impresiones · {formatCount(d.yearAgo.clicks)} clics · posición{' '}
            {d.yearAgo.position === null ? '—' : formatNumber(d.yearAgo.position, 1)}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-xs">
            Ahora: {formatCount(d.current.impressions)} impresiones
            {d.impressionsPct !== null && (
              <SeoChange value={d.impressionsPct} suffix=" %" decimals={0} />
            )}
            {d.positionDiff !== null && (
              <>
                · puestos <SeoChange value={d.positionDiff} suffix="" />
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
