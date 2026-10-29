'use client';

import { ArrowRight, Download, Loader2, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { AdminTenantAdoptionDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminAdoption } from '@/lib/admin/hooks';
import { downloadCsv } from '@/lib/csv';

function exportCsv(tenants: AdminTenantAdoptionDto[]) {
  const limit = (used: number, max: number | null) => (max === null ? `${used}` : `${used}/${max}`);
  downloadCsv('adopcion-tenants.csv', [
    [
      'Tenant',
      'Slug',
      'Plan',
      'Funciones que usa',
      'Fuera de su plan',
      'Trasteros',
      'Locales',
      'Usuarios',
      'Paga al mes (EUR)',
      'Candidato',
      'Plan recomendado',
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
      t.isCandidate ? 'Sí' : 'No',
      t.recommendedPlanName ?? '',
    ]),
  ]);
}

export default function AdminAdoptionPage() {
  const q = useAdminAdoption();
  const [onlyCandidates, setOnlyCandidates] = useState(false);

  const tenants = useMemo(() => {
    const all = q.data?.tenants ?? [];
    return onlyCandidates ? all.filter((t) => t.isCandidate) : all;
  }, [q.data, onlyCandidates]);

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
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Adopción y upsell</h1>
          <p className="text-sm text-muted-foreground">
            Qué features premium usa cada tenant y quién es candidato a subir de plan (usa features
            que no tiene, topa sus límites contando los extras o el plan superior no le cuesta más
            que lo que ya paga con los extras).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => exportCsv(d.tenants)}>
          <Download className="mr-1.5 size-4" /> Exportar CSV
        </Button>
      </div>

      {/* Adopción global por feature. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Adopción por feature</CardTitle>
          <p className="text-xs text-muted-foreground">
            Tenants que la usan (verde) sobre los que la tienen incluida en su plan.
          </p>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {d.featureAdoption.map((f) => {
            const pct = f.tenantsWithAccess > 0 ? (f.tenantsUsing / f.tenantsWithAccess) * 100 : 0;
            return (
              <div key={f.feature} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 truncate">{f.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-green-500"
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {f.tenantsUsing}/{f.tenantsWithAccess}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Candidatos + filtro. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="size-4 text-amber-600" />
            {d.candidateCount} candidato(s) a upgrade
          </CardTitle>
          <Button
            variant={onlyCandidates ? 'default' : 'outline'}
            size="sm"
            onClick={() => setOnlyCandidates((v) => !v)}
          >
            {onlyCandidates ? 'Ver todos' : 'Solo candidatos'}
          </Button>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Sin tenants para este filtro.</p>
          ) : (
            <ul className="divide-y">
              {tenants.map((t) => (
                <AdoptionRow key={t.tenantId} t={t} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

function limitClass(value: number, max: number | null): string {
  if (max == null) return 'text-muted-foreground';
  return value >= max ? 'text-red-600 font-medium' : 'text-muted-foreground';
}

function AdoptionRow({ t }: { t: AdminTenantAdoptionDto }) {
  const usedFeatures = t.features.filter((f) => f.used);
  const availableUnused = t.features.filter((f) => (f.inPlan || f.viaOverride) && !f.used).length;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t.name}</span>
          <span className="text-xs text-muted-foreground">/{t.slug}</span>
          <Badge variant="outline">{t.planName ?? 'sin plan'}</Badge>
          {t.isCandidate && (
            <Badge className="border-0 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              Subir a {t.recommendedPlanName}
              {t.recommendedPlanPrice !== null ? ` (${eur(t.recommendedPlanPrice)}/mes)` : ''}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">Paga {eur(t.monthlyPaid)}/mes</span>
        </div>
        {/* Features usadas (ámbar = fuera del plan actual). */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {usedFeatures.length === 0 ? (
            <span className="text-xs text-muted-foreground">Sin features premium en uso</span>
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
        {/* Uso vs límites. */}
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
        </div>
      </div>
      <Button asChild variant="outline" size="icon" aria-label="Ver tenant" title="Ver tenant">
        <Link href={`/admin/tenants/${t.tenantId}`}>
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    </li>
  );
}
