'use client';

import { ArrowRight, Download, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type {
  AdminHealthSegment,
  AdminTenantHealthDto,
  AdminTenantHealthLevel,
} from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAdminTenantsHealth } from '@/lib/admin/hooks';
import { useLoadMore } from '@/lib/admin/use-load-more';
import { downloadCsv } from '@/lib/csv';
import { plural } from '@/lib/format';

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

const SEGMENTS: { key: AdminHealthSegment; label: string; help: string }[] = [
  {
    key: 'paying',
    label: 'Clientes',
    help: 'Clientes que pagan (al día o con el pago atrasado). Puntuación de 0 a 100 según la actividad del equipo, si factura al día, la suscripción, la adopción, el área de clientes de sus inquilinos y el soporte. Lo que no aplica (sin contratos que facturar, sin área de clientes) no cuenta y su peso se reparte.',
  },
  {
    key: 'trial',
    label: 'Pruebas',
    help: 'Pruebas en curso con su activación: local creado (15 %), trasteros (15 %), primer inquilino (15 %), primer contrato firmado (25 %), primera factura (15 %) y equipo entrando (15 %).',
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

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : 'nunca';
}

export default function AdminHealthPage() {
  const [segment, setSegment] = useState<AdminHealthSegment>('paying');
  const health = useAdminTenantsHealth(segment);
  const [levelFilter, setLevelFilter] = useState<AdminTenantHealthLevel | null>(null);
  const [q, setQ] = useState('');

  const all = useMemo(() => health.data?.tenants ?? [], [health.data]);
  const seg = SEGMENTS.find((s) => s.key === segment) ?? SEGMENTS[0]!;
  const isActivation = segment === 'trial';

  function exportCsv() {
    const factorKeys = all[0]?.factors.map((f) => f.label) ?? [];
    downloadCsv(`salud-${seg.label.toLowerCase().replace(/\s+/g, '-')}.csv`, [
      [
        'Tenant',
        'Identificador',
        'Estado',
        'Plan',
        isActivation ? 'Activación' : 'Puntuación',
        'Nivel',
        'Cambio en el mes',
        ...factorKeys,
        'Último acceso',
      ],
      ...all.map((t) => [
        t.name,
        t.slug,
        t.status,
        t.planName ?? '',
        t.score,
        LEVEL_BY_KEY.get(t.level)?.label ?? t.level,
        t.trend ?? '',
        ...t.factors.map((f) => (f.counted ? f.score : 'no cuenta')),
        t.lastActivityAt ? new Date(t.lastActivityAt).toLocaleDateString('es-ES') : '',
      ]),
    ]);
  }

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of all) m[t.level] = (m[t.level] ?? 0) + 1;
    return m;
  }, [all]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((t) => !levelFilter || t.level === levelFilter)
      .filter(
        (t) =>
          !needle || t.name.toLowerCase().includes(needle) || t.slug.toLowerCase().includes(needle),
      );
  }, [all, levelFilter, q]);
  const page = useLoadMore(items, 25, `${segment}|${levelFilter}|${q}`);

  function changeSegment(next: AdminHealthSegment) {
    setSegment(next);
    setLevelFilter(null);
  }

  if (health.isError) {
    return <AdminError onRetry={() => void health.refetch()} />;
  }

  return (
    <div className="min-w-0 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Salud de los tenants</h1>
          <p className="text-sm text-muted-foreground">{seg.help}</p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={all.length === 0}>
          <Download className="mr-1.5 size-4" /> Exportar CSV
        </Button>
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
          {/* Resumen por nivel (clicable para filtrar). */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {LEVELS.map((l) => {
              const active = levelFilter === l.key;
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setLevelFilter(active ? null : l.key)}
                  className={`min-w-0 rounded-lg border px-4 py-3 text-left transition ${
                    active ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50'
                  }`}
                >
                  <div className="text-2xl font-bold">{counts[l.key] ?? 0}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`inline-block size-2 shrink-0 rounded-full ${l.bar}`} />
                    {l.label}
                  </div>
                </button>
              );
            })}
          </div>

          <Card className="min-w-0">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {levelFilter ? LEVEL_BY_KEY.get(levelFilter)?.label : 'Todos'} ·{' '}
                {plural(items.length, 'tenant', 'tenants')}
              </CardTitle>
              <Input
                placeholder="Buscar tenant…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full sm:max-w-xs"
              />
            </CardHeader>
            <CardContent>
              {items.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Sin tenants para este filtro.</p>
              ) : (
                <>
                  <ul className="divide-y">
                    {page.visible.map((t) => (
                      <HealthRow key={t.tenantId} t={t} />
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
                  La tendencia compara con la foto del mes pasado (se guarda cada noche; la última,
                  el {fmtDate(health.data.snapshotAt)}).
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function HealthRow({ t }: { t: AdminTenantHealthDto }) {
  const level = LEVEL_BY_KEY.get(t.level);
  return (
    <li className="flex flex-wrap items-center gap-4 py-3">
      {/* Puntuación + barra. */}
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
      </div>

      {/* Identidad + factores. */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-medium">{t.name}</span>
          <span className="text-xs text-muted-foreground">/{t.slug}</span>
          <Badge className={`${level?.badge} border-0`}>{level?.label}</Badge>
          {t.planName && <span className="text-xs text-muted-foreground">· {t.planName}</span>}
          {t.trialEndsAt && (
            <span className="text-xs text-muted-foreground">
              · prueba hasta el {fmtDate(t.trialEndsAt)}
            </span>
          )}
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
          <span>· último acceso {fmtDate(t.lastActivityAt)}</span>
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
