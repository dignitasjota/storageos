'use client';

import {
  CHURN_RISK_LABELS,
  PAY_PROBABILITY_LABELS,
  type AdminHealthSegment,
  type AdminTenantHealthDto,
  type AdminTenantHealthLevel,
} from '@storageos/shared';
import { Download, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { TenantsBulkBar } from '../tenants/tenants-bulk-bar';

import { AdminError } from '@/components/admin/admin-error';
import { HealthSettingsButton } from '@/components/admin/health/health-settings-dialog';
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
import { Sparkline } from '@/components/admin/health/sparkline';
import { TenantRowActions } from '@/components/admin/health/tenant-row-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminTenantsHealth } from '@/lib/admin/hooks';
import { useLoadMore } from '@/lib/admin/use-load-more';
import { downloadCsv } from '@/lib/csv';
import { formatEur, plural } from '@/lib/format';

const LEVELS: {
  key: AdminTenantHealthLevel;
  label: string;
  badge: string;
  bar: string;
}[] = [
  {
    key: 'healthy',
    label: 'Saludable',
    badge: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
    bar: 'bg-green-500',
  },
  {
    key: 'warm',
    label: 'Tibio',
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    bar: 'bg-sky-500',
  },
  {
    key: 'at_risk',
    label: 'En riesgo',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    bar: 'bg-amber-500',
  },
  {
    key: 'dormant',
    label: 'Dormido',
    badge: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    bar: 'bg-red-500',
  },
];

const LEVEL_BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

const RISK_TONE: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  low: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
};
const PROB_TONE: Record<string, string> = {
  high: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  low: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

const SEGMENTS: { key: AdminHealthSegment; label: string; help: string }[] = [
  {
    key: 'paying',
    label: 'Clientes',
    help: 'Clientes que pagan (al día o con el pago atrasado). Puntuación de 0 a 100 según la actividad del equipo (lo reciente y, con un mes de registro, cuántos días entran), si factura al día, la suscripción, la adopción, el área de clientes de sus inquilinos y el soporte. Lo que no aplica no cuenta y su peso se reparte.',
  },
  {
    key: 'trial',
    label: 'Pruebas',
    help: 'Pruebas en curso con su activación (local, trasteros, primer inquilino, primer contrato firmado, primera factura y equipo entrando) y la probabilidad de que acaben pagando según su activación y los días que les quedan.',
  },
  {
    key: 'unpaid',
    label: 'Sin pagar',
    help: 'Activos que no pagan: plan gratis, prueba terminada en solo lectura o suscripción cancelada.',
  },
  {
    key: 'exempt',
    label: 'Exentas',
    help: 'Cuentas exentas de facturación (las nuestras, demos, socios). No cuenta la suscripción.',
  },
];

type SortKey = 'score' | 'mrr' | 'name' | 'trend' | 'activeDays' | 'probability';

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : 'nunca';
}

function sortValue(t: AdminTenantHealthDto, k: SortKey): number | string {
  switch (k) {
    case 'mrr':
      return t.mrr || (t.wouldPay ?? 0);
    case 'name':
      return t.name;
    case 'trend':
      return t.trend ?? 0;
    case 'activeDays':
      return t.activeDays30 ?? -1;
    case 'probability':
      return t.payProbability ?? -1;
    default:
      return t.score;
  }
}

function riskLabel(t: AdminTenantHealthDto): string {
  if (t.churnRisk) return CHURN_RISK_LABELS[t.churnRisk];
  if (t.payProbabilityLevel) {
    return `${PAY_PROBABILITY_LABELS[t.payProbabilityLevel]} que pague (${t.payProbability} %)`;
  }
  return '';
}

export default function AdminHealthPage() {
  const [segment, setSegment] = useState<AdminHealthSegment>('paying');
  const health = useAdminTenantsHealth(segment);
  const [levelFilter, setLevelFilter] = useState<AdminTenantHealthLevel | null>(null);
  const [filters, setFilters] = useState<ListFilters>({
    ...EMPTY_LIST_FILTERS,
    risk: '',
    sortKey: 'score',
    sortDir: 'asc',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const all = useMemo(() => health.data?.tenants ?? [], [health.data]);
  const seg = SEGMENTS.find((s) => s.key === segment) ?? SEGMENTS[0]!;
  const isActivation = segment === 'trial';
  const sort: SortState<SortKey> = {
    key: (filters.sortKey as SortKey) || 'score',
    dir: filters.sortDir === 'desc' ? -1 : 1,
  };
  const onSort = (k: SortKey) => {
    const n = nextSort(sort, k, ['name']);
    setFilters({ ...filters, sortKey: n.key, sortDir: n.dir === 1 ? 'asc' : 'desc' });
  };

  const counts = useMemo(() => {
    const m: Record<string, { n: number; mrr: number }> = {};
    for (const t of all) {
      const c = (m[t.level] ??= { n: 0, mrr: 0 });
      c.n += 1;
      c.mrr += t.mrr;
    }
    return m;
  }, [all]);

  const items = useMemo(() => {
    const risk = String(filters.risk ?? '');
    const list = all
      .filter((t) => !levelFilter || t.level === levelFilter)
      .filter((t) => matchesListFilters(t, filters))
      .filter(
        (t) => !risk || t.churnRisk === risk || (isActivation && t.payProbabilityLevel === risk),
      );
    return sortRows(list, sort, sortValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, levelFilter, filters, isActivation]);
  const page = useLoadMore(items, 25, `${segment}|${levelFilter}|${JSON.stringify(filters)}`);
  useEffect(() => setSelected(new Set()), [segment, levelFilter, filters]);

  function changeSegment(next: AdminHealthSegment) {
    setSegment(next);
    setLevelFilter(null);
  }
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportCsv(rows: AdminTenantHealthDto[], suffix = '') {
    const factorKeys = rows[0]?.factors.map((f) => f.label) ?? [];
    downloadCsv(`salud-${seg.label.toLowerCase().replace(/\s+/g, '-')}${suffix}.csv`, [
      [
        'Tenant',
        'Identificador',
        'Estado',
        'Plan',
        'Comercial',
        'Cuota al mes sin IVA (EUR)',
        isActivation ? 'Activación' : 'Puntuación',
        'Nivel',
        isActivation ? 'Probabilidad de pagar (%)' : 'Riesgo de baja',
        'Cambio en el mes',
        'Días activos (30)',
        'Usuarios activos (30)',
        'Usuarios',
        'Lo que más resta',
        'Acción sugerida',
        ...factorKeys,
        'Último acceso',
      ],
      ...rows.map((t) => [
        t.name,
        t.slug,
        t.status,
        t.planName ?? '',
        t.salesRepName ?? '',
        isActivation ? (t.wouldPay ?? '') : t.mrr,
        t.score,
        LEVEL_BY_KEY.get(t.level)?.label ?? t.level,
        isActivation ? (t.payProbability ?? '') : t.churnRisk ? CHURN_RISK_LABELS[t.churnRisk] : '',
        t.trend ?? '',
        t.activeDays30 ?? '',
        t.activeUsers30 ?? '',
        t.totalUsers,
        t.mainDrag ? `${t.mainDrag.label} (−${t.mainDrag.lostPoints})` : '',
        t.mainDrag?.action.label ?? '',
        ...t.factors.map((f) => (f.counted ? f.score : 'no cuenta')),
        t.lastActivityAt ? new Date(t.lastActivityAt).toLocaleDateString('es-ES') : '',
      ]),
    ]);
  }

  if (health.isError) {
    return <AdminError onRetry={() => void health.refetch()} />;
  }

  const allVisibleSelected =
    page.visible.length > 0 && page.visible.every((t) => selected.has(t.tenantId));
  const selectedRows = all.filter((t) => selected.has(t.tenantId));
  const risk = health.data?.mrrAtRisk;

  return (
    <div className="min-w-0 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Salud de los tenants</h1>
          <p className="text-sm text-muted-foreground">{seg.help}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <HealthSettingsButton section="health" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportCsv(items)}
            disabled={items.length === 0}
          >
            <Download className="mr-1.5 size-4" /> Exportar CSV
          </Button>
        </div>
      </div>

      {/* Grupos: clientes, pruebas, sin pagar y exentas. */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Grupo de tenants">
        {SEGMENTS.map((s) => {
          const active = s.key === segment;
          const n = health.data?.counts[s.key];
          return (
            <Button
              key={s.key}
              role="tab"
              aria-selected={active}
              variant={active ? 'default' : 'outline'}
              size="sm"
              onClick={() => changeSegment(s.key)}
            >
              {s.label}
              {n !== undefined ? ` · ${n}` : ''}
            </Button>
          );
        })}
      </div>

      {health.isLoading || !health.data ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Dinero en riesgo: la cuota de los en riesgo y dormidos. */}
          {!isActivation && risk && (
            <div className="rounded-lg border bg-card px-4 py-3 text-sm">
              <span className="font-medium">MRR en riesgo: {formatEur(risk.total)}/mes</span>{' '}
              <span className="text-muted-foreground">
                sin IVA · en riesgo {formatEur(risk.atRisk)} · dormidos {formatEur(risk.dormant)}
              </span>
            </div>
          )}

          {/* Resumen por nivel (clicable para filtrar). */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {LEVELS.map((l) => {
              const active = levelFilter === l.key;
              const c = counts[l.key];
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setLevelFilter(active ? null : l.key)}
                  className={`min-w-0 rounded-lg border px-4 py-3 text-left transition ${
                    active ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50'
                  }`}
                >
                  <div className="text-2xl font-bold">{c?.n ?? 0}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`inline-block size-2 shrink-0 rounded-full ${l.bar}`} />
                    {l.label}
                  </div>
                  {!isActivation && (c?.mrr ?? 0) > 0 && (
                    <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {formatEur(c!.mrr)}/mes
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <TenantsBulkBar
            selected={[...selected]}
            trialCount={selectedRows.filter((t) => t.status === 'trial').length}
            showTrial={isActivation}
            onClear={() => setSelected(new Set())}
            onExport={() => exportCsv(selectedRows, '-seleccion')}
          />

          <Card className="min-w-0">
            <CardHeader className="space-y-3">
              <CardTitle className="text-base">
                {levelFilter ? LEVEL_BY_KEY.get(levelFilter)?.label : 'Todos'} ·{' '}
                {plural(items.length, 'tenant', 'tenants')}
              </CardTitle>
              <ListControls page="health" rows={all} filters={filters} onChange={setFilters}>
                <Select
                  value={String(filters.risk || '__all__')}
                  onValueChange={(v) => setFilters({ ...filters, risk: v === '__all__' ? '' : v })}
                >
                  <SelectTrigger className="h-9 w-full sm:w-[170px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">
                      {isActivation ? 'Toda probabilidad' : 'Todo riesgo'}
                    </SelectItem>
                    {(['high', 'medium', 'low'] as const).map((k) => (
                      <SelectItem key={k} value={k}>
                        {isActivation ? PAY_PROBABILITY_LABELS[k] : CHURN_RISK_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                <SortButton
                  label={isActivation ? 'Activación' : 'Puntuación'}
                  k="score"
                  sort={sort}
                  onSort={onSort}
                />
                <SortButton label="Cuota" k="mrr" sort={sort} onSort={onSort} />
                {isActivation ? (
                  <SortButton label="Probabilidad" k="probability" sort={sort} onSort={onSort} />
                ) : (
                  <SortButton label="Cambio" k="trend" sort={sort} onSort={onSort} />
                )}
                <SortButton label="Días activos" k="activeDays" sort={sort} onSort={onSort} />
                <SortButton label="Nombre" k="name" sort={sort} onSort={onSort} />
              </div>
            </CardHeader>
            <CardContent>
              {items.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Sin tenants para este filtro.</p>
              ) : (
                <>
                  <ul className="divide-y">
                    {page.visible.map((t) => (
                      <HealthRow
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
              {health.data.snapshotAt && (
                <p className="pt-3 text-xs text-muted-foreground">
                  La tendencia compara con la foto del mes pasado y la mini gráfica, con las de las
                  últimas 8 semanas (se guardan cada noche; la última, el{' '}
                  {fmtDate(health.data.snapshotAt)}).
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function HealthRow({
  t,
  selected,
  onToggle,
}: {
  t: AdminTenantHealthDto;
  selected: boolean;
  onToggle: () => void;
}) {
  const level = LEVEL_BY_KEY.get(t.level);
  const risk = riskLabel(t);
  const tone = t.churnRisk
    ? RISK_TONE[t.churnRisk]
    : t.payProbabilityLevel
      ? PROB_TONE[t.payProbabilityLevel]
      : '';
  return (
    <li className={`flex flex-wrap items-start gap-3 py-3 ${selected ? 'bg-primary/5' : ''}`}>
      <Checkbox
        aria-label={`Seleccionar ${t.name}`}
        checked={selected}
        onCheckedChange={onToggle}
        className="mt-1"
      />
      {/* Puntuación, barra y evolución. */}
      <div className="w-24 shrink-0">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums">{t.score}</span>
          <span className="text-xs text-muted-foreground">/100</span>
        </div>
        {t.trend !== null && t.trend !== 0 && (
          <div
            className={`text-xs tabular-nums ${t.trend > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
            title="Frente al mes pasado"
          >
            {t.trend > 0 ? '▲' : '▼'} {Math.abs(t.trend)} este mes
          </div>
        )}
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${level?.bar}`} style={{ width: `${t.score}%` }} />
        </div>
        <div className="mt-1">
          <Sparkline values={t.sparkline} label="Puntuación de las últimas semanas" />
        </div>
      </div>

      {/* Identidad, dinero, actividad y factores. */}
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/admin/tenants/${t.tenantId}?tab=business`}
            className="min-w-0 break-words font-medium hover:underline"
          >
            {t.name}
          </Link>
          <span className="text-xs text-muted-foreground">/{t.slug}</span>
          <Badge className={`${level?.badge} border-0`}>{level?.label}</Badge>
          {risk && <Badge className={`${tone} border-0`}>{risk}</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {t.planName && <span>{t.planName}</span>}
          {t.mrr > 0 && <span className="tabular-nums">· {formatEur(t.mrr)}/mes</span>}
          {t.wouldPay !== null && (
            <span className="tabular-nums">· pagaría {formatEur(t.wouldPay)}/mes</span>
          )}
          {t.trialDaysLeft !== null && (
            <span>
              ·{' '}
              {t.trialDaysLeft > 0
                ? `le ${t.trialDaysLeft === 1 ? 'queda 1 día' : `quedan ${t.trialDaysLeft} días`} de prueba`
                : 'prueba vencida'}
            </span>
          )}
          {t.salesRepName && <span>· {t.salesRepName}</span>}
          <span>
            ·{' '}
            {t.activeDays30 !== null
              ? `${plural(t.activeDays30, 'día activo', 'días activos')} de 30 · ${t.activeUsers30 ?? 0} de ${plural(t.totalUsers, 'usuario', 'usuarios')}`
              : `último acceso ${fmtDate(t.lastActivityAt)}`}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {t.factors.map((f) => (
            <span key={f.key} title={f.detail}>
              {f.counted ? (
                <span className="font-medium tabular-nums">{f.score}</span>
              ) : (
                <span className="italic">no cuenta</span>
              )}{' '}
              {f.label.toLowerCase()}
            </span>
          ))}
        </div>
        {t.mainDrag && (
          <p className="mt-1 text-xs">
            <span className="font-medium">Lo que más resta:</span> {t.mainDrag.label.toLowerCase()}{' '}
            (−{t.mainDrag.lostPoints} puntos) · {t.mainDrag.detail}
          </p>
        )}
      </div>

      <TenantRowActions
        tenantId={t.tenantId}
        tenantName={t.name}
        suggested={t.mainDrag?.action ?? null}
      />
    </li>
  );
}
