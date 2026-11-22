'use client';

import { Download, Loader2, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { TenantsBulkBar } from '../tenants/tenants-bulk-bar';

import { CandidatesTab } from './candidates-tab';
import { FeaturesTab } from './features-tab';

import type { AdminTenantAdoptionDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import {
  EMPTY_LIST_FILTERS,
  ListControls,
  type ListFilters,
  matchesListFilters,
  nextSort,
  SortButton,
  sortRows,
  type SortState,
} from '@/components/admin/health/list-controls';
import { TenantRowActions } from '@/components/admin/health/tenant-row-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useAdminAdoption } from '@/lib/admin/hooks';
import { useLoadMore } from '@/lib/admin/use-load-more';
import { downloadCsv } from '@/lib/csv';
import { formatEur, plural } from '@/lib/format';

type Tab = 'tenants' | 'candidates' | 'features';
type Filter = 'all' | 'candidates' | 'near' | 'paidUnused';
type SortKey = 'candidates' | 'name' | 'paid' | 'features' | 'units' | 'paidUnused';

function exportCsv(tenants: AdminTenantAdoptionDto[], name = 'adopcion-tenants.csv') {
  const limit = (used: number, max: number | null) => (max === null ? `${used}` : `${used}/${max}`);
  downloadCsv(name, [
    [
      'Tenant',
      'Identificador',
      'Estado',
      'Plan',
      'Comercial',
      'Funciones que usa',
      'Usos en 30 días',
      'Fuera de su plan',
      'Extras que paga y no usa',
      'Pagado sin uso al mes sin IVA (EUR)',
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
      t.status,
      t.planName ?? t.planSlug ?? '',
      t.salesRepName ?? '',
      t.features
        .filter((f) => f.used)
        .map((f) => f.label)
        .join(', '),
      t.features
        .filter((f) => f.uses30 !== null && f.uses30 > 0)
        .map((f) => `${f.label}: ${f.uses30}`)
        .join(', '),
      t.features
        .filter((f) => f.used && !f.inPlan && !f.viaOverride)
        .map((f) => f.label)
        .join(', '),
      t.paidUnused.map((p) => p.addonName).join(', '),
      t.paidUnusedMonthly,
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

function sortValue(t: AdminTenantAdoptionDto, k: SortKey): number | string {
  switch (k) {
    case 'name':
      return t.name;
    case 'paid':
      return t.monthlyPaid || (t.wouldPay ?? 0);
    case 'features':
      return t.features.filter((f) => f.used).length;
    case 'units':
      return t.usage.maxUnits ? t.usage.units / t.usage.maxUnits : 0;
    case 'paidUnused':
      return t.paidUnusedMonthly;
    default:
      return (t.isCandidate ? 2 : 0) + (t.nearLimit ? 1 : 0);
  }
}

export default function AdminAdoptionPage() {
  const q = useAdminAdoption();
  const [tab, setTab] = useState<Tab>('tenants');
  const [filters, setFilters] = useState<ListFilters>({
    ...EMPTY_LIST_FILTERS,
    kind: 'all',
    sortKey: 'candidates',
    sortDir: 'desc',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filter = (filters.kind as Filter) || 'all';
  const sort: SortState<SortKey> = {
    key: (filters.sortKey as SortKey) || 'candidates',
    dir: filters.sortDir === 'asc' ? 1 : -1,
  };
  const onSort = (k: SortKey) => {
    const n = nextSort(sort, k, ['name']);
    setFilters({ ...filters, sortKey: n.key, sortDir: n.dir === 1 ? 'asc' : 'desc' });
  };

  const all = useMemo(() => q.data?.tenants ?? [], [q.data]);
  const tenants = useMemo(() => {
    const list = all
      .filter((t) =>
        filter === 'candidates'
          ? t.isCandidate
          : filter === 'near'
            ? t.nearLimit
            : filter === 'paidUnused'
              ? t.paidUnused.length > 0
              : true,
      )
      .filter((t) => matchesListFilters(t, filters));
    return sortRows(list, sort, sortValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filters]);
  const page = useLoadMore(tenants, 25, JSON.stringify(filters));
  useEffect(() => setSelected(new Set()), [filters]);

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
  const allVisibleSelected =
    page.visible.length > 0 && page.visible.every((t) => selected.has(t.tenantId));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="min-w-0 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Adopción y venta</h1>
          <p className="text-sm text-muted-foreground">
            Qué funciones de pago usa de verdad cada tenant y con qué intensidad, qué extras paga
            sin usar y quién es candidato a subir de plan o contratar un extra. Solo se recomiendan
            planes públicos y con margen (los trasteros, como mucho al 80 %). Importes sin IVA.
          </p>
        </div>
        {tab === 'tenants' && (
          <Button variant="outline" size="sm" onClick={() => exportCsv(tenants)}>
            <Download className="mr-1.5 size-4" /> Exportar CSV
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Vista">
        {(
          [
            ['tenants', 'Tenants'],
            ['candidates', 'Candidatos'],
            ['features', 'Funciones'],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            role="tab"
            aria-selected={tab === key}
            variant={tab === key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {tab === 'candidates' ? (
        <CandidatesTab />
      ) : tab === 'features' ? (
        <FeaturesTab adoption={d} />
      ) : (
        <>
          <TenantsBulkBar
            selected={[...selected]}
            trialCount={all.filter((t) => selected.has(t.tenantId) && t.inTrial).length}
            onClear={() => setSelected(new Set())}
            onExport={() =>
              exportCsv(
                all.filter((t) => selected.has(t.tenantId)),
                'adopcion-seleccion.csv',
              )
            }
          />
          <Card className="min-w-0">
            <CardHeader className="space-y-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <TrendingUp className="size-4 shrink-0 text-amber-600" />
                {plural(d.candidateCount, 'candidato', 'candidatos')} a subir de plan
                <span className="text-sm font-normal text-muted-foreground">
                  · {plural(d.nearLimitCount, 'tenant cerca', 'tenants cerca')} de un límite ·{' '}
                  {plural(d.paidUnusedCount, 'paga', 'pagan')} extras sin usarlos
                </span>
              </CardTitle>
              <ListControls page="adoption" rows={all} filters={filters} onChange={setFilters}>
                {(
                  [
                    ['all', 'Todos'],
                    ['candidates', 'Candidatos'],
                    ['near', 'Cerca del límite'],
                    ['paidUnused', 'Pagan y no usan'],
                  ] as const
                ).map(([key, label]) => (
                  <Button
                    key={key}
                    variant={filter === key ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setFilters({ ...filters, kind: key })}
                  >
                    {label}
                  </Button>
                ))}
              </ListControls>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <Checkbox
                  aria-label="Seleccionar los visibles"
                  checked={allVisibleSelected ? true : selected.size > 0 ? 'indeterminate' : false}
                  onCheckedChange={() =>
                    setSelected(
                      allVisibleSelected ? new Set() : new Set(page.visible.map((t) => t.tenantId)),
                    )
                  }
                  className="mr-2"
                />
                Ordenar por:
                <SortButton label="Candidatos" k="candidates" sort={sort} onSort={onSort} />
                <SortButton label="Lo que aporta" k="paid" sort={sort} onSort={onSort} />
                <SortButton label="Funciones en uso" k="features" sort={sort} onSort={onSort} />
                <SortButton label="Uso de trasteros" k="units" sort={sort} onSort={onSort} />
                <SortButton label="Pagado sin uso" k="paidUnused" sort={sort} onSort={onSort} />
                <SortButton label="Nombre" k="name" sort={sort} onSort={onSort} />
              </div>
            </CardHeader>
            <CardContent>
              {tenants.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Sin tenants para este filtro.</p>
              ) : (
                <>
                  <ul className="divide-y">
                    {page.visible.map((t) => (
                      <AdoptionRow
                        key={t.tenantId}
                        t={t}
                        selected={selected.has(t.tenantId)}
                        onToggle={() => toggle(t.tenantId)}
                      />
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
        </>
      )}
    </div>
  );
}

function limitClass(value: number, max: number | null): string {
  if (max == null) return 'text-muted-foreground';
  if (value >= max) return 'text-red-600 font-medium';
  if (max >= 2 && value >= max * 0.8) return 'text-amber-600 font-medium';
  return 'text-muted-foreground';
}

function AdoptionRow({
  t,
  selected,
  onToggle,
}: {
  t: AdminTenantAdoptionDto;
  selected: boolean;
  onToggle: () => void;
}) {
  const usedFeatures = t.features.filter((f) => f.used);
  const availableUnused = t.features.filter((f) => (f.inPlan || f.viaOverride) && !f.used).length;

  return (
    <li
      className={`flex flex-wrap items-start gap-x-3 gap-y-2 py-3 ${selected ? 'bg-primary/5' : ''}`}
    >
      <Checkbox
        aria-label={`Seleccionar ${t.name}`}
        checked={selected}
        onCheckedChange={onToggle}
        className="mt-1"
      />
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/admin/tenants/${t.tenantId}?tab=business`}
            className="min-w-0 break-words font-medium hover:underline"
          >
            {t.name}
          </Link>
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
            {t.salesRepName ? ` · ${t.salesRepName}` : ''}
          </span>
        </div>
        {/* Funciones usadas (ámbar = fuera del plan actual) con su intensidad. */}
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
                title={`${
                  f.inPlan
                    ? 'En su plan'
                    : f.viaOverride
                      ? 'Activada aparte (extra o cortesía)'
                      : 'Fuera de su plan'
                }${f.uses30 !== null ? ` · ${f.uses30} en 30 días, ${f.uses90} en 90` : ''}`}
              >
                {f.label}
                {f.viaOverride ? ' · extra' : ''}
                {f.uses30 !== null ? ` · ${f.uses30.toLocaleString('es-ES')}` : ''}
              </span>
            ))
          )}
          {availableUnused > 0 && (
            <span className="text-xs text-muted-foreground">+{availableUnused} sin usar</span>
          )}
        </div>
        {t.paidUnused.length > 0 && (
          <p className="mt-1 text-xs text-red-700 dark:text-red-400">
            Paga y no usa: {t.paidUnused.map((p) => p.addonName).join(', ')} (
            {formatEur(t.paidUnusedMonthly)}/mes): riesgo de que lo dé de baja.
          </p>
        )}
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
      <TenantRowActions
        tenantId={t.tenantId}
        tenantName={t.name}
        defaultFollowupTitle={
          t.paidUnused.length > 0
            ? `Ayudarle a usar ${t.paidUnused[0]!.label}`
            : 'Revisar su uso del producto'
        }
      />
    </li>
  );
}
