'use client';

import { AlertTriangle, Download, HardDrive, LineChart, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { TenantsBulkBar } from '../tenants/tenants-bulk-bar';

import { formatBytes, UsageEvolution } from './usage-evolution';

import type { AdminTenantUsageRowDto, AdminUsageDto } from '@storageos/shared';

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
import { TenantRowActions } from '@/components/admin/health/tenant-row-actions';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAdminUsage, useMeasureStorage } from '@/lib/admin/hooks';
import { useLoadMore } from '@/lib/admin/use-load-more';
import { ApiError } from '@/lib/auth/api';
import { downloadCsv } from '@/lib/csv';
import { formatEur, formatPct, plural } from '@/lib/format';

type SortKey = 'bounce' | 'emails' | 'ai' | 'storage' | 'name' | 'margin' | 'whatsapp';

/** Un rebote por encima del 5 % o cualquier queja de spam pone en riesgo la cuenta de envío. */
const BOUNCE_ALERT = 5;

/** Nombre legible de cada tipo de fichero (bucket). */
const BUCKET_LABELS: Record<string, string> = {
  uploads: 'documentos',
  invoices: 'facturas',
  plans: 'planos',
  reports: 'informes',
  public: 'web',
};

const usd = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const num = (n: number) => n.toLocaleString('es-ES');
const eur = formatEur;
/** Resumen de los precios por modelo usados en el periodo. */
function aiPricingHint(p: AdminUsageDto['aiPricing']): string {
  if (p.models.length === 0) {
    return `Por modelo; si no lo conocemos, ${p.inputPerMTokUsd} $ / ${p.outputPerMTokUsd} $ por millón de tokens`;
  }
  return p.models
    .slice(0, 3)
    .map(
      (m) =>
        `${m.model}: ${m.inputPerMTokUsd} $ / ${m.outputPerMTokUsd} $${m.known ? '' : ' (respaldo)'}`,
    )
    .join(' · ')
    .concat(' por millón de tokens');
}

function bucketLabel(name: string): string {
  const key = Object.keys(BUCKET_LABELS).find((k) => name.includes(k));
  return key ? BUCKET_LABELS[key]! : name;
}

const emailAlert = (r: AdminTenantUsageRowDto) =>
  r.email.complaints > 0 || (r.email.bounceRate ?? 0) > BOUNCE_ALERT;

function sortValue(r: AdminTenantUsageRowDto, k: SortKey): number | string {
  switch (k) {
    case 'emails':
      return r.email.sent;
    case 'ai':
      return r.ai.costUsd || r.ai.calls / 1e6;
    case 'storage':
      return r.storage.bytes;
    case 'name':
      return r.tenantName;
    case 'margin':
      return r.margin?.margin ?? -1e12;
    case 'whatsapp':
      return r.whatsapp.messages;
    default:
      return (
        (r.anomalies.length > 0 ? 2e6 : 0) + (emailAlert(r) ? 1e6 : 0) + (r.email.bounceRate ?? -1)
      );
  }
}

/** Para los filtros comunes (las filas de Uso llaman al tenant `tenantName`). */
const filterable = (r: AdminTenantUsageRowDto) => ({
  ...r,
  name: r.tenantName,
  slug: r.tenantSlug,
});

export default function AdminUsagePage() {
  const [days, setDays] = useState(30);
  const [filters, setFilters] = useState<ListFilters>({
    ...EMPTY_LIST_FILTERS,
    anomalies: false,
    sortKey: 'bounce',
    sortDir: 'desc',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [evolutionOf, setEvolutionOf] = useState<AdminTenantUsageRowDto | null>(null);
  const usage = useAdminUsage(days);
  const measure = useMeasureStorage();
  const sort: SortState<SortKey> = {
    key: (filters.sortKey as SortKey) || 'bounce',
    dir: filters.sortDir === 'asc' ? 1 : -1,
  };
  const onSort = (k: SortKey) => {
    const n = nextSort(sort, k, ['name']);
    setFilters({ ...filters, sortKey: n.key, sortDir: n.dir === 1 ? 'asc' : 'desc' });
  };

  const all = useMemo(() => usage.data?.rows ?? [], [usage.data]);
  const rows = useMemo(() => {
    const list = all
      .filter((r) => matchesListFilters(filterable(r), filters))
      .filter((r) => !filters.anomalies || r.anomalies.length > 0);
    return sortRows(list, sort, sortValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filters]);
  const page = useLoadMore(rows, 25, `${days}|${JSON.stringify(filters)}`);
  useEffect(() => setSelected(new Set()), [filters, days]);

  function exportCsv(list: AdminTenantUsageRowDto[], name = `uso-tenants-${days}-dias.csv`) {
    downloadCsv(name, [
      [
        'Tenant',
        'Identificador',
        'Estado',
        'Plan',
        'Comercial',
        'Correos enviados',
        'Rebotes',
        'Fallidos',
        'Quejas de spam',
        '% de rebotes',
        'Mensajes de WhatsApp',
        'Llamadas a la IA',
        'Tokens de entrada',
        'Tokens de salida',
        'Coste estimado de IA (USD)',
        'IA por modelo',
        'Llamadas con su clave',
        'Llamadas del asistente de SEO',
        'Coste del asistente de SEO (USD)',
        'Consultas este mes',
        'Límite de consultas',
        'Paga por la IA al mes (EUR)',
        'Almacenamiento (bytes)',
        'Ficheros',
        'Cobrado sin IVA en el periodo (EUR)',
        'Costes estimados (EUR)',
        'Margen (EUR)',
        'Margen (%)',
        'Consumo anómalo',
      ],
      ...list.map((r) => [
        r.tenantName,
        r.tenantSlug,
        r.status,
        r.planName ?? '',
        r.salesRepName ?? '',
        r.email.sent,
        r.email.bounced,
        r.email.failed,
        r.email.complaints,
        r.email.bounceRate ?? '',
        r.whatsapp.messages,
        r.ai.calls,
        r.ai.inputTokens,
        r.ai.outputTokens,
        r.ai.costUsd,
        r.aiByModel.map((m) => `${m.model}: ${m.costUsd}`).join(', '),
        r.ai.ownKeyCalls,
        r.ai.seoAssistantCalls,
        r.ai.seoAssistantCostUsd,
        r.ai.queriesThisMonth,
        r.ai.queryLimit ?? '',
        r.ai.revenueMonthly,
        r.storage.bytes,
        r.storage.objects,
        r.margin?.revenue ?? '',
        r.margin?.costs ?? '',
        r.margin?.margin ?? '',
        r.margin?.marginPct ?? '',
        r.anomalies.map((a) => a.detail).join(' · '),
      ]),
    ]);
  }

  async function onMeasure() {
    try {
      const r = await measure.mutateAsync();
      toast.success(
        `${plural(r.tenants, 'tenant medido', 'tenants medidos')}: ${formatBytes(r.bytes)} en total.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo medir.');
    }
  }

  if (usage.isError) return <AdminError onRetry={() => void usage.refetch()} />;

  const data = usage.data;
  const alerts = data?.rows.filter(emailAlert).length ?? 0;
  const allVisibleSelected =
    page.visible.length > 0 && page.visible.every((r) => selected.has(r.tenantId));

  return (
    <div className="min-w-0 space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Uso por tenant</h1>
          <p className="text-sm text-muted-foreground">
            Correos que envía cada negocio a sus inquilinos (la cuenta de envío es compartida: sus
            rebotes y quejas afectan a todos), WhatsApp, IA por modelo, espacio en ficheros y el
            margen de cada uno, con aviso del consumo anómalo.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <HealthSettingsButton section="usage" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportCsv(rows)}
            disabled={rows.length === 0}
          >
            <Download className="mr-2 size-4" /> Exportar CSV
          </Button>
          <Button variant="outline" size="sm" onClick={onMeasure} disabled={measure.isPending}>
            {measure.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 size-4" />
            )}
            Medir almacenamiento
          </Button>
        </div>
      </div>

      {!data ? (
        <div className="flex h-[30vh] items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Kpi
              label={`Correos enviados (${data.days} días)`}
              value={num(data.totals.emailsSent)}
            />
            <Kpi
              label="Tenants con problemas de correo"
              value={num(alerts)}
              tone={alerts > 0 ? 'warn' : undefined}
            />
            <Kpi
              label="Tenants con consumo anómalo (30 días)"
              value={num(data.anomalyCount)}
              tone={data.anomalyCount > 0 ? 'warn' : undefined}
              hint="Más de lo habitual frente a sus 3 meses anteriores"
            />
            <Kpi
              label={`Coste estimado de IA (${data.days} días, sin las claves propias)`}
              value={usd(data.totals.aiCostUsd)}
              hint={aiPricingHint(data.aiPricing)}
            />
            <Kpi
              label="Ingresos por IA al mes"
              value={eur(data.totals.aiRevenueMonthly)}
              hint="Extra del asistente y de consultas"
            />
            <Kpi
              label="Almacenamiento total"
              value={formatBytes(data.totals.storageBytes)}
              hint={
                data.storageMeasuredAt
                  ? `Medido el ${new Date(data.storageMeasuredAt).toLocaleString('es-ES')}`
                  : 'Aún sin medir'
              }
            />
          </div>

          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <LineChart className="size-4 text-muted-foreground" /> Evolución de todos
              </CardTitle>
            </CardHeader>
            <CardContent>
              <UsageEvolution tenantId={null} />
            </CardContent>
          </Card>

          <TenantsBulkBar
            selected={[...selected]}
            trialCount={all.filter((r) => selected.has(r.tenantId) && r.status === 'trial').length}
            onClear={() => setSelected(new Set())}
            onExport={() =>
              exportCsv(
                all.filter((r) => selected.has(r.tenantId)),
                'uso-seleccion.csv',
              )
            }
          />

          <Card className="min-w-0">
            <CardHeader className="space-y-3 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDrive className="size-4 text-muted-foreground" />
                {plural(rows.length, 'tenant', 'tenants')}
              </CardTitle>
              <ListControls
                page="usage"
                rows={all.map(filterable)}
                filters={filters}
                onChange={setFilters}
              >
                <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                  <SelectTrigger className="h-9 w-full sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">Últimos 7 días</SelectItem>
                    <SelectItem value="30">Últimos 30 días</SelectItem>
                    <SelectItem value="90">Últimos 90 días</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant={filters.anomalies ? 'default' : 'outline'}
                  onClick={() => setFilters({ ...filters, anomalies: !filters.anomalies })}
                >
                  Con consumo anómalo
                </Button>
              </ListControls>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <Checkbox
                  aria-label="Seleccionar los visibles"
                  checked={allVisibleSelected ? true : selected.size > 0 ? 'indeterminate' : false}
                  onCheckedChange={() =>
                    setSelected(
                      allVisibleSelected ? new Set() : new Set(page.visible.map((r) => r.tenantId)),
                    )
                  }
                  className="mr-2"
                />
                Ordenar por:
                <SortButton label="Avisos" k="bounce" sort={sort} onSort={onSort} />
                <SortButton label="Correos" k="emails" sort={sort} onSort={onSort} />
                <SortButton label="WhatsApp" k="whatsapp" sort={sort} onSort={onSort} />
                <SortButton label="IA" k="ai" sort={sort} onSort={onSort} />
                <SortButton label="Almacenamiento" k="storage" sort={sort} onSort={onSort} />
                <SortButton label="Margen" k="margin" sort={sort} onSort={onSort} />
                <SortButton label="Nombre" k="name" sort={sort} onSort={onSort} />
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin resultados.</p>
              ) : (
                <>
                  {page.visible.map((r) => (
                    <UsageRow
                      key={r.tenantId}
                      r={r}
                      marginMonths={data.marginMonths}
                      selected={selected.has(r.tenantId)}
                      onToggle={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.tenantId)) next.delete(r.tenantId);
                          else next.add(r.tenantId);
                          return next;
                        })
                      }
                      onEvolution={() => setEvolutionOf(r)}
                    />
                  ))}
                  {page.hasMore && (
                    <div className="pt-1 text-center">
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

      <Sheet open={!!evolutionOf} onOpenChange={(v) => !v && setEvolutionOf(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Evolución de {evolutionOf?.tenantName}</SheetTitle>
            <SheetDescription>
              Correos, WhatsApp e IA de cada mes y el almacenamiento con su previsión.
            </SheetDescription>
          </SheetHeader>
          {evolutionOf && (
            <div className="mt-4">
              <UsageEvolution tenantId={evolutionOf.tenantId} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warn';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={`mt-1 text-xl font-semibold tabular-nums ${
            tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''
          }`}
        >
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function UsageRow({
  r,
  marginMonths,
  selected,
  onToggle,
  onEvolution,
}: {
  r: AdminTenantUsageRowDto;
  marginMonths: number;
  selected: boolean;
  onToggle: () => void;
  onEvolution: () => void;
}) {
  const alert = emailAlert(r) || r.anomalies.length > 0;
  const buckets = Object.entries(r.storage.byBucket)
    .filter(([, b]) => b > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div
      className={`min-w-0 space-y-2 rounded-md border p-3 text-sm ${
        alert ? 'border-amber-300 dark:border-amber-800' : ''
      } ${selected ? 'bg-primary/5' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <Checkbox
          aria-label={`Seleccionar ${r.tenantName}`}
          checked={selected}
          onCheckedChange={onToggle}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/admin/tenants/${r.tenantId}?tab=business`}
            className="min-w-0 break-words font-medium hover:underline"
          >
            {r.tenantName}
          </Link>
          <span className="ml-1 text-xs text-muted-foreground">
            /{r.tenantSlug}
            {r.planName ? ` · ${r.planName}` : ''}
            {r.salesRepName ? ` · ${r.salesRepName}` : ''}
          </span>
        </div>
        <Button variant="ghost" size="sm" className="h-8" onClick={onEvolution}>
          <LineChart className="mr-1 size-4" /> Evolución
        </Button>
        <TenantRowActions
          tenantId={r.tenantId}
          tenantName={r.tenantName}
          defaultFollowupTitle="Revisar su consumo"
        />
      </div>

      {r.anomalies.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
          {r.anomalies.map((a, i) => (
            <li key={i} className="flex items-start gap-1">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {a.detail}
            </li>
          ))}
        </ul>
      )}

      <div className="grid min-w-0 gap-2 text-xs md:grid-cols-4">
        <div>
          <span className="text-muted-foreground">Correo: </span>
          {plural(r.email.sent, 'enviado', 'enviados')}
          {r.email.bounceRate !== null && (
            <span
              className={
                (r.email.bounceRate ?? 0) > BOUNCE_ALERT ? 'font-medium text-red-600' : undefined
              }
            >
              {' '}
              · {r.email.bounceRate.toLocaleString('es-ES')} % rebotes
            </span>
          )}
          {r.email.complaints > 0 && (
            <span className="font-medium text-red-600">
              {' '}
              · {plural(r.email.complaints, 'queja de spam', 'quejas de spam')}
            </span>
          )}
          {r.email.failed > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · {plural(r.email.failed, 'fallido', 'fallidos')}
            </span>
          )}
          {r.whatsapp.messages > 0 && (
            <div className="text-muted-foreground">
              {plural(r.whatsapp.messages, 'mensaje', 'mensajes')} de WhatsApp
            </div>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">IA: </span>
          {r.ai.calls === 0 && r.ai.ownKeyCalls === 0 ? (
            <span className="text-muted-foreground">sin uso</span>
          ) : (
            <>
              {r.ai.calls > 0 && (
                <>
                  {plural(r.ai.calls, 'llamada', 'llamadas')} · {usd(r.ai.costUsd)}
                </>
              )}
              {r.ai.ownKeyCalls > 0 && (
                <span className="text-muted-foreground">
                  {r.ai.calls > 0 ? ' · ' : ''}
                  {num(r.ai.ownKeyCalls)} con su propia clave
                </span>
              )}
              {r.ai.seoAssistantCalls > 0 && (
                <div className="text-muted-foreground">
                  Asistente de SEO: {plural(r.ai.seoAssistantCalls, 'llamada', 'llamadas')} ·{' '}
                  {usd(r.ai.seoAssistantCostUsd)}
                </div>
              )}
            </>
          )}
          {r.aiByModel.length > 0 && (
            <div className="text-muted-foreground">
              {r.aiByModel
                .slice(0, 3)
                .map((m) => `${m.model}: ${usd(m.costUsd)}`)
                .join(' · ')}
            </div>
          )}
          {r.ai.queryLimit != null && (
            <div className="text-muted-foreground">
              <span
                className={
                  r.ai.queriesThisMonth >= r.ai.queryLimit ? 'font-medium text-red-600' : undefined
                }
              >
                {num(r.ai.queriesThisMonth)} de {num(r.ai.queryLimit)} consultas este mes
              </span>
              {r.ai.revenueMonthly > 0 && ` · paga ${eur(r.ai.revenueMonthly)}/mes`}
            </div>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Almacenamiento: </span>
          {r.storage.measuredAt
            ? `${formatBytes(r.storage.bytes)} (${plural(r.storage.objects, 'fichero', 'ficheros')})`
            : '—'}
          {buckets.length > 0 && (
            <div className="text-muted-foreground">
              {buckets
                .slice(0, 3)
                .map(([b, bytes]) => `${bucketLabel(b)}: ${formatBytes(bytes)}`)
                .join(' · ')}
            </div>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">
            Margen ({plural(marginMonths, 'mes', 'meses')}):{' '}
          </span>
          {r.margin ? (
            <>
              <span className={r.margin.margin < 0 ? 'font-medium text-red-600' : 'font-medium'}>
                {eur(r.margin.margin)}
              </span>
              {r.margin.marginPct !== null && ` (${formatPct(r.margin.marginPct)})`}
              <div className="text-muted-foreground">
                cobrado {eur(r.margin.revenue)} · costes {eur(r.margin.costs)}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">sin cobros</span>
          )}
        </div>
      </div>
    </div>
  );
}
