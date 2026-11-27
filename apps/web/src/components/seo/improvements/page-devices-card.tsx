'use client';

import { SEO_MOBILE_MIN_IMPRESSIONS, pagePath } from '@storageos/shared';
import { ExternalLink, Smartphone } from 'lucide-react';
import { useState } from 'react';

import type { SeoPanelParams } from '@/lib/seo-advanced/panel';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCount, formatNumber, formatPct } from '@/lib/format';
import { usePageDevices, type ImprovementScope } from '@/lib/seo-advanced/improvement-hooks';

/** PageSpeed de Google, ya en móvil, para una página. */
export const pageSpeedMobileUrl = (page: string) =>
  `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(page)}&form_factor=mobile`;

const pct = (n: number | null) => (n === null ? '—' : formatPct(n * 100));
const pos = (n: number | null) => (n === null ? '—' : formatNumber(n, 1));

/**
 * Páginas con su CTR y su posición en móvil y en ordenador (mejora 11),
 * marcando las que en móvil van claramente peor y con el enlace para medir su
 * velocidad en móvil.
 */
export function SeoPageDevicesCard({
  scope,
  params,
}: {
  scope: ImprovementScope;
  params: SeoPanelParams;
}) {
  const [onlyWorse, setOnlyWorse] = useState(false);
  const data = usePageDevices(
    scope,
    { ...params, onlyWorse },
    params.period !== 'custom' || (!!params.from && !!params.to),
  );
  const d = data.data;
  const worse = d?.items.filter((i) => i.worseOnMobile).length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="size-4" aria-hidden /> Páginas en móvil frente a ordenador
        </CardTitle>
        <CardDescription>
          Una página que en móvil recibe muchos menos clics (o sale varios puestos más abajo) que en
          ordenador suele tener un problema de móvil: lenta, difícil de leer o con botones que no se
          pulsan. Solo se juzgan páginas con al menos {SEO_MOBILE_MIN_IMPRESSIONS} impresiones en
          cada dispositivo.
        </CardDescription>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={onlyWorse}
            onCheckedChange={(v) => setOnlyWorse(v === true)}
            aria-label="Ver solo las que van peor en móvil"
          />
          Ver solo las que van peor en móvil
        </label>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.isError ? (
          <SectionError onRetry={() => void data.refetch()} />
        ) : !d ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : !d.hasData ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay datos por dispositivo y página (se descargan con Search Console cada día).
          </p>
        ) : d.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ninguna página va claramente peor en móvil.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {worse > 0
                ? `${worse} página${worse === 1 ? '' : 's'} va${worse === 1 ? '' : 'n'} claramente peor en móvil.`
                : 'Ninguna va claramente peor en móvil.'}
            </p>
            <ul className="divide-y rounded-md border">
              {d.items.map((r) => (
                <li key={r.page} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 break-all font-medium">{pagePath(r.page)}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      {r.worseOnMobile && (
                        <Badge
                          variant="outline"
                          className="border-amber-300 font-normal text-amber-800 dark:border-amber-700 dark:text-amber-300"
                        >
                          Peor en móvil
                        </Badge>
                      )}
                      <a
                        href={pageSpeedMobileUrl(r.page)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        Medir en móvil <ExternalLink className="size-3" aria-hidden />
                      </a>
                    </div>
                  </div>
                  {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">Móvil: CTR · posición</dt>
                      <dd>
                        {pct(r.mobile.ctr)} · {pos(r.mobile.position)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Móvil: impresiones</dt>
                      <dd>{formatCount(r.mobile.impressions)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ordenador: CTR · posición</dt>
                      <dd>
                        {pct(r.desktop.ctr)} · {pos(r.desktop.position)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ordenador: impresiones</dt>
                      <dd>{formatCount(r.desktop.impressions)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
