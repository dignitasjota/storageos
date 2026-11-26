'use client';

import { Tag } from 'lucide-react';

import type { SeoPanelParams } from '@/lib/seo-advanced/panel';
import type { SeoBrandSideDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount, formatDate, formatNumber, formatPct } from '@/lib/format';
import { useBrandSplit, type ImprovementScope } from '@/lib/seo-advanced/improvement-hooks';

function Side({
  title,
  hint,
  side,
  previous,
}: {
  title: string;
  hint: string;
  side: SeoBrandSideDto;
  previous: boolean;
}) {
  const change = (now: number, before: number | null) => {
    if (!previous || before === null || before === 0) return null;
    const pct = Math.round(((now - before) / before) * 100);
    return `${pct > 0 ? '+' : ''}${pct} % frente al periodo anterior`;
  };
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <p className="text-2xl font-semibold tabular-nums">
        {formatCount(side.clicks)} <span className="text-sm font-normal">clics</span>
      </p>
      {change(side.clicks, side.previousClicks) && (
        <p className="text-xs text-muted-foreground">{change(side.clicks, side.previousClicks)}</p>
      )}
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Impresiones</dt>
          <dd className="tabular-nums">{formatCount(side.impressions)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">CTR</dt>
          <dd className="tabular-nums">{side.ctr === null ? '—' : formatPct(side.ctr * 100)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Posición</dt>
          <dd className="tabular-nums">
            {side.position === null ? '—' : formatNumber(side.position, 1)}
          </dd>
        </div>
      </dl>
      {side.clickShare !== null && (
        <p className="text-xs text-muted-foreground">
          {formatPct(side.clickShare * 100)} de los clics con detalle
        </p>
      )}
    </div>
  );
}

/**
 * Marca frente a no marca (mejora 3): de dónde vienen los clics, de gente que ya
 * te conoce (busca tu nombre) o de gente que te descubre. Usa los términos de
 * marca del proyecto; sin ellos invita a ponerlos.
 */
export function SeoBrandSplitCard({
  scope,
  params,
}: {
  scope: ImprovementScope;
  params: SeoPanelParams;
}) {
  const split = useBrandSplit(
    scope,
    params,
    params.period !== 'custom' || (!!params.from && !!params.to),
  );
  const d = split.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="size-4" aria-hidden /> Marca frente a no marca
        </CardTitle>
        <CardDescription>
          {d
            ? `Del ${formatDate(d.from)} al ${formatDate(d.to)}. Marca: quien busca tu nombre. Sin marca: quien te descubre buscando lo que ofreces. Solo cuentan las búsquedas que Google detalla.`
            : 'Cuántos clics vienen de quien ya te conoce y cuántos de quien te descubre.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {split.isError ? (
          <SectionError onRetry={() => void split.refetch()} />
        ) : !d ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : d.needsTerms ? (
          <p className="text-sm text-muted-foreground">
            Este proyecto no tiene términos de marca (por ejemplo, el nombre de tu negocio).
            Añádelos en «Datos del proyecto» y aquí verás la diferencia entre quien te busca por
            nombre y quien te descubre.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Side
              title="De marca"
              hint={`Contienen: ${d.terms.join(', ')}`}
              side={d.brand}
              previous={d.previousAvailable}
            />
            <Side
              title="Sin marca"
              hint="Descubrimiento: lo que buscan sin saber quién eres"
              side={d.nonBrand}
              previous={d.previousAvailable}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
