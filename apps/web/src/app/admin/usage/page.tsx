'use client';

import { HardDrive, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { AdminTenantUsageRowDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminUsage, useMeasureStorage } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type SortKey = 'bounce' | 'emails' | 'ai' | 'storage' | 'name';

/** Un rebote por encima del 5 % o cualquier queja de spam pone en riesgo la cuenta de envío. */
const BOUNCE_ALERT = 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} ${units[i]}`;
}
const usd = (n: number) =>
  `$${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => n.toLocaleString('es-ES');
const emailAlert = (r: AdminTenantUsageRowDto) =>
  r.email.complaints > 0 || (r.email.bounceRate ?? 0) > BOUNCE_ALERT;

export default function AdminUsagePage() {
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState<SortKey>('bounce');
  const [search, setSearch] = useState('');
  const usage = useAdminUsage(days);
  const measure = useMeasureStorage();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (usage.data?.rows ?? []).filter(
      (r) => !q || r.tenantName.toLowerCase().includes(q) || r.tenantSlug.includes(q),
    );
    const by: Record<SortKey, (a: AdminTenantUsageRowDto, b: AdminTenantUsageRowDto) => number> = {
      bounce: (a, b) =>
        Number(emailAlert(b)) - Number(emailAlert(a)) ||
        (b.email.bounceRate ?? -1) - (a.email.bounceRate ?? -1),
      emails: (a, b) => b.email.sent - a.email.sent,
      ai: (a, b) => b.ai.costUsd - a.ai.costUsd || b.ai.calls - a.ai.calls,
      storage: (a, b) => b.storage.bytes - a.storage.bytes,
      name: (a, b) => a.tenantName.localeCompare(b.tenantName),
    };
    return [...list].sort(by[sort]);
  }, [usage.data, sort, search]);

  async function onMeasure() {
    try {
      const r = await measure.mutateAsync();
      toast.success(`Medidos ${r.tenants} tenants: ${formatBytes(r.bytes)} en total.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo medir.');
    }
  }

  if (usage.isError) return <AdminError onRetry={() => void usage.refetch()} />;

  const data = usage.data;
  const alerts = data?.rows.filter(emailAlert).length ?? 0;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Uso por tenant</h1>
          <p className="text-sm text-muted-foreground">
            Correos que envía cada negocio a sus inquilinos (la cuenta de envío es compartida: sus
            rebotes y quejas afectan a todos), consumo del asistente de IA y espacio en ficheros.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onMeasure} disabled={measure.isPending}>
          {measure.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 size-4" />
          )}
          Medir almacenamiento
        </Button>
      </div>

      {!data ? (
        <div className="flex h-[30vh] items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              label={`Coste estimado de IA (${data.days} días)`}
              value={usd(data.totals.aiCostUsd)}
              hint={`$${data.aiPricing.inputPerMTokUsd} / $${data.aiPricing.outputPerMTokUsd} por millón de tokens`}
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

          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder="Buscar tenant…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-base sm:w-64 sm:text-sm"
            />
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Últimos 7 días</SelectItem>
                <SelectItem value="30">Últimos 30 días</SelectItem>
                <SelectItem value="90">Últimos 90 días</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bounce">Problemas de correo primero</SelectItem>
                <SelectItem value="emails">Más correos</SelectItem>
                <SelectItem value="ai">Más gasto de IA</SelectItem>
                <SelectItem value="storage">Más almacenamiento</SelectItem>
                <SelectItem value="name">Nombre</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDrive className="size-4 text-muted-foreground" />
                Tenants ({rows.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin resultados.</p>
              ) : (
                rows.map((r) => <UsageRow key={r.tenantId} r={r} />)
              )}
            </CardContent>
          </Card>
        </>
      )}
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

function UsageRow({ r }: { r: AdminTenantUsageRowDto }) {
  const alert = emailAlert(r);
  return (
    <div
      className={`grid gap-2 rounded-md border p-3 text-sm md:grid-cols-[1.4fr_1.4fr_1.2fr_1fr] md:items-center ${
        alert ? 'border-amber-300 dark:border-amber-800' : ''
      }`}
    >
      <Link href={`/admin/tenants/${r.tenantId}`} className="min-w-0 font-medium hover:underline">
        {r.tenantName}
        <span className="ml-1 text-xs font-normal text-muted-foreground">/{r.tenantSlug}</span>
      </Link>
      <div className="text-xs">
        <span className="text-muted-foreground md:hidden">Correo: </span>
        {num(r.email.sent)} enviados
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
          <span className="font-medium text-red-600"> · {r.email.complaints} quejas de spam</span>
        )}
        {r.email.failed > 0 && (
          <span className="text-muted-foreground"> · {r.email.failed} fallidos</span>
        )}
      </div>
      <div className="text-xs">
        <span className="text-muted-foreground md:hidden">IA: </span>
        {r.ai.calls === 0 ? (
          <span className="text-muted-foreground">Sin uso de IA</span>
        ) : (
          <>
            {num(r.ai.calls)} llamadas · {num(r.ai.inputTokens + r.ai.outputTokens)} tokens ·{' '}
            {usd(r.ai.costUsd)}
          </>
        )}
      </div>
      <div className="text-xs md:text-right">
        <span className="text-muted-foreground md:hidden">Almacenamiento: </span>
        {r.storage.measuredAt
          ? `${formatBytes(r.storage.bytes)} (${num(r.storage.objects)} ficheros)`
          : '—'}
      </div>
    </div>
  );
}
