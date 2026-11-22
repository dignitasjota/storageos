'use client';

import { ArrowRight, Download, Loader2, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { AdminTenantAdoptionDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAdminAdoption } from '@/lib/admin/hooks';
import { useLoadMore } from '@/lib/admin/use-load-more';
import { downloadCsv } from '@/lib/csv';
import { formatEur, plural } from '@/lib/format';

type Filter = 'all' | 'candidates' | 'near';
type Sort = 'candidates' | 'name' | 'paid';

function exportCsv(tenants: AdminTenantAdoptionDto[]) {
  const limit = (used: number, max: number | null) => (max === null ? `${used}` : `${used}/${max}`);
  downloadCsv('adopcion-tenants.csv', [
    [
      'Tenant',
      'Identificador',
      'Plan',
      'Funciones que usa',
      'Fuera de su plan',
      'Trasteros',
      'Locales',
      'Usuarios',
      'Aporta al mes sin IVA (EUR)',
      'En prueba: pagaría al mes sin IVA (EUR)',
      'Límite',
      'Candidato a subir de plan',
      'Plan recomendado',
      'Precio del plan recomendado sin IVA (EUR)',
    ],
    ...tenants.map((t) => [
      t.name,
      t.slug,
      t.planName ?? t.planSlug ?? '',
      t.features
        .filter((f) => f.used)
        .map((f) => f.label)
        .join(', '),
      t.features
        .filter((f) => f.used && !f.inPlan && !f.viaOverride)
        .map((f) => f.label)
        .join(', '),
      limit(t.usage.units, t.usage.maxUnits),
      limit(t.usage.facilities, t.usage.maxFacilities),
      limit(t.usage.users, t.usage.maxUsers),
      t.monthlyPaid,
      t.wouldPay ?? '',
      t.tapsLimit
        ? `Topa: ${t.limitDetail ?? ''}`
        : t.nearLimit
          ? `Cerca: ${t.limitDetail ?? ''}`
          : '',
      t.isCandidate ? 'Sí' : 'No',
      t.recommendedPlanName ?? '',
      t.recommendedPlanPrice ?? '',
    ]),
  ]);
}

export default function AdminAdoptionPage() {
  const q = useAdminAdoption();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('candidates');
  const [search, setSearch] = useState('');

  const tenants = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (q.data?.tenants ?? [])
      .filter((t) =>
        filter === 'candidates' ? t.isCandidate : filter === 'near' ? t.nearLimit : true,
      )
      .filter(
        (t) =>
          !needle || t.name.toLowerCase().includes(needle) || t.slug.toLowerCase().includes(needle),
      );
    const byName = (a: AdminTenantAdoptionDto, b: AdminTenantAdoptionDto) =>
      a.name.localeCompare(b.name);
    if (sort === 'name') return [...list].sort(byName);
    if (sort === 'paid') {
      return [...list].sort((a, b) => b.monthlyPaid - a.monthlyPaid || byName(a, b));
    }
    return list; // el servidor ya da los candidatos primero
  }, [q.data, filter, sort, search]);
  const page = useLoadMore(tenants, 25, `${filter}|${sort}|${search}`);

  if (q.isError) {
    return <AdminError onRetry={() => void q.refetch()} />;
  }
  if (q.isLoading || !q.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const d = q.data;

  return (
    <div className="min-w-0 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Adopción y venta</h1>
          <p className="text-sm text-muted-foreground">
            Qué funciones de pago usa de verdad cada tenant y quién es candidato a subir de plan:
            usa funciones que no tiene, topa un límite (contando los extras) o el plan superior no
            le cuesta más de lo que ya paga con los extras. Solo se recomiendan planes públicos y
            con margen (los trasteros, como mucho al 80 %). Importes sin IVA.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => exportCsv(d.tenants)}>
          <Download className="mr-1.5 size-4" /> Exportar CSV
        </Button>
      </div>

      {/* Adopción global por función. */}
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Adopción por función</CardTitle>
          <p className="text-xs text-muted-foreground">
            Tenants que la usan (verde) sobre los que la tienen en su plan o como extra. Uso en los
            últimos 90 días donde hay fecha; si no, configuración activa (pasa el ratón por el
            nombre para ver cómo se mide).
          </p>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {d.featureAdoption.map((f) => {
            const pct = f.tenantsWithAccess > 0 ? (f.tenantsUsing / f.tenantsWithAccess) * 100 : 0;
            return (
              <div key={f.feature} className="flex min-w-0 items-center gap-3 text-sm">
                <span className="w-32 shrink-0 truncate sm:w-44" title={f.signal}>
                  {f.label}
                </span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-green-500"
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {f.tenantsUsing}/{f.tenantsWithAccess}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Candidatos + filtros. */}
      <Card className="min-w-0">
        <CardHeader className="space-y-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <TrendingUp className="size-4 shrink-0 text-amber-600" />
            {plural(d.candidateCount, 'candidato', 'candidatos')} a subir de plan
            <span className="text-sm font-normal text-muted-foreground">
              · {plural(d.nearLimitCount, 'tenant cerca', 'tenants cerca')} de un límite
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['all', 'Todos'],
                ['candidates', 'Candidatos'],
                ['near', 'Cerca del límite'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                variant={filter === key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter(key)}
              >
                {label}
              </Button>
            ))}
            <select
              aria-label="Ordenar"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="candidates">Candidatos primero</option>
              <option value="paid">Lo que aporta</option>
              <option value="name">Nombre</option>
            </select>
            <Input
              placeholder="Buscar tenant…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:max-w-xs"
            />
          </div>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Sin tenants para este filtro.</p>
          ) : (
            <>
              <ul className="divide-y">
                {page.visible.map((t) => (
                  <AdoptionRow key={t.tenantId} t={t} />
                ))}
              </ul>
              {page.hasMore && (
                <div className="pt-3 text-center">
                  <Button variant="outline" size="sm" onClick={page.loadMore}>
                    Cargar más ({plural(page.remaining, 'queda', 'quedan')})
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function limitClass(value: number, max: number | null): string {
  if (max == null) return 'text-muted-foreground';
  if (value >= max) return 'text-red-600 font-medium';
  if (max >= 2 && value >= max * 0.8) return 'text-amber-600 font-medium';
  return 'text-muted-foreground';
}

function AdoptionRow({ t }: { t: AdminTenantAdoptionDto }) {
  const usedFeatures = t.features.filter((f) => f.used);
  const availableUnused = t.features.filter((f) => (f.inPlan || f.viaOverride) && !f.used).length;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-medium">{t.name}</span>
          <span className="text-xs text-muted-foreground">/{t.slug}</span>
          <Badge variant="outline">{t.planName ?? 'sin plan'}</Badge>
          {t.isCandidate && (
            <Badge className="border-0 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              Subir a {t.recommendedPlanName}
              {t.recommendedPlanPrice !== null ? ` (${formatEur(t.recommendedPlanPrice)}/mes)` : ''}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {t.inTrial
              ? `En prueba${t.wouldPay !== null ? `, pagaría ${formatEur(t.wouldPay)}/mes` : ''}`
              : `Aporta ${formatEur(t.monthlyPaid)}/mes`}
          </span>
        </div>
        {/* Funciones usadas (ámbar = fuera del plan actual). */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {usedFeatures.length === 0 ? (
            <span className="text-xs text-muted-foreground">Sin funciones de pago en uso</span>
          ) : (
            usedFeatures.map((f) => (
              <span
                key={f.feature}
                className={`rounded px-1.5 py-0.5 text-xs ${
                  f.inPlan
                    ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                    : f.viaOverride
                      ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 ring-1 ring-amber-300'
                }`}
                title={
                  f.inPlan
                    ? 'En su plan'
                    : f.viaOverride
                      ? 'Activada aparte (extra o cortesía)'
                      : 'Fuera de su plan'
                }
              >
                {f.label}
                {f.viaOverride ? ' · extra' : ''}
              </span>
            ))
          )}
          {availableUnused > 0 && (
            <span className="text-xs text-muted-foreground">+{availableUnused} sin usar</span>
          )}
        </div>
        {/* Uso frente a los límites. */}
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
          <span className={limitClass(t.usage.units, t.usage.maxUnits)}>
            Trasteros {t.usage.units}
            {t.usage.maxUnits != null ? `/${t.usage.maxUnits}` : ''}
          </span>
          <span className={limitClass(t.usage.facilities, t.usage.maxFacilities)}>
            Locales {t.usage.facilities}
            {t.usage.maxFacilities != null ? `/${t.usage.maxFacilities}` : ''}
          </span>
          <span className={limitClass(t.usage.users, t.usage.maxUsers)}>
            Usuarios {t.usage.users}
            {t.usage.maxUsers != null ? `/${t.usage.maxUsers}` : ''}
          </span>
          {t.limitDetail && (
            <span className={t.tapsLimit ? 'text-red-600' : 'text-amber-600'}>
              · {t.tapsLimit ? 'Topa' : 'Cerca'}: {t.limitDetail}
            </span>
          )}
        </div>
      </div>
      <Button asChild variant="outline" size="icon" aria-label="Ver tenant" title="Ver tenant">
        <Link href={`/admin/tenants/${t.tenantId}?tab=business`}>
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    </li>
  );
}
