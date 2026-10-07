'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { AdminTenantBillingHealthDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAdminBillingHealth } from '@/lib/admin/hooks';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : '—');

const AEAT_LABEL: Record<string, string> = {
  rejected: 'Rechazada',
  error: 'Error',
  pending: 'Sin respuesta',
};

function issueCount(t: AdminTenantBillingHealthDto): number {
  return (
    t.aeatRejected +
    t.aeatError +
    t.aeatPendingStale +
    t.holdedReview +
    (t.certificateDaysLeft !== null && t.certificateDaysLeft <= 30 ? 1 : 0)
  );
}

/**
 * Salud de la facturación de los tenants: facturas rechazadas o sin respuesta
 * de la AEAT, envíos de Holded para revisar y caducidad del certificado.
 */
export default function AdminBillingHealthPage() {
  const health = useAdminBillingHealth();
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [search, setSearch] = useState('');

  const tenants = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (health.data?.tenants ?? []).filter(
      (t) =>
        (!onlyIssues || issueCount(t) > 0) &&
        (!q || t.tenantName.toLowerCase().includes(q) || t.tenantSlug.includes(q)),
    );
  }, [health.data, onlyIssues, search]);

  if (health.isError) return <AdminError onRetry={() => void health.refetch()} />;
  if (health.isLoading || !health.data) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const invoices = health.data.invoices;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facturación de los tenants</h1>
        <p className="text-sm text-muted-foreground">
          Veri*Factu, Holded y certificados de la AEAT de cada negocio. Una factura rechazada o sin
          respuesta de la AEAT, o un certificado caducado, impide que el tenant cumpla con
          Veri*Factu.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar tenant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-base sm:w-64 sm:text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyIssues}
            onChange={(e) => setOnlyIssues(e.target.checked)}
          />
          Solo con problemas
        </label>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por tenant</CardTitle>
          <CardDescription>
            Solo aparecen los tenants con certificado, Holded o alguna incidencia.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {tenants.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" />
              {onlyIssues ? 'Ningún tenant tiene problemas de facturación.' : 'Sin resultados.'}
            </p>
          ) : (
            tenants.map((t) => <TenantRow key={t.tenantId} t={t} />)
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Facturas con problemas en la AEAT</CardTitle>
          <CardDescription>
            Rechazadas, con error o enviadas hace más de 48 h sin respuesta (las 50 más recientes).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay facturas con problemas.</p>
          ) : (
            invoices.map((i) => (
              <div
                key={i.invoiceId}
                className="flex flex-col gap-1 rounded-md border p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <span className="font-medium">{i.invoiceNumber ?? 'Sin número'}</span>
                  <span className="text-muted-foreground"> · </span>
                  <Link
                    href={`/admin/tenants/${i.tenantId}`}
                    className="text-muted-foreground hover:underline"
                  >
                    {i.tenantName}
                  </Link>
                  {i.message && (
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={i.message}
                    >
                      {i.message}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Emitida {fmtDate(i.issueDate)}
                  </span>
                  <Badge variant={i.aeatStatus === 'pending' ? 'secondary' : 'destructive'}>
                    {AEAT_LABEL[i.aeatStatus] ?? i.aeatStatus}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TenantRow({ t }: { t: AdminTenantBillingHealthDto }) {
  const chips: { label: string; tone: 'red' | 'amber' | 'muted' }[] = [];
  if (t.aeatRejected > 0) chips.push({ label: `${t.aeatRejected} rechazada(s)`, tone: 'red' });
  if (t.aeatError > 0) chips.push({ label: `${t.aeatError} con error`, tone: 'red' });
  if (t.aeatPendingStale > 0)
    chips.push({ label: `${t.aeatPendingStale} sin respuesta >48 h`, tone: 'amber' });
  if (t.holdedReview > 0)
    chips.push({ label: `Holded: ${t.holdedReview} para revisar`, tone: 'amber' });
  if (t.certificateDaysLeft !== null) {
    if (t.certificateDaysLeft <= 0)
      chips.push({ label: `Certificado caducado (${fmtDate(t.certificateValidTo)})`, tone: 'red' });
    else if (t.certificateDaysLeft <= 30)
      chips.push({ label: `Certificado caduca en ${t.certificateDaysLeft} d`, tone: 'amber' });
    else chips.push({ label: `Certificado hasta ${fmtDate(t.certificateValidTo)}`, tone: 'muted' });
  } else if (t.invoicingMode === 'app') {
    chips.push({ label: 'Sin certificado', tone: 'muted' });
  }
  const toneClass = {
    red: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    muted: 'bg-muted text-muted-foreground',
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Link href={`/admin/tenants/${t.tenantId}`} className="font-medium hover:underline">
          {t.tenantName}
        </Link>
        <span className="ml-2 text-xs text-muted-foreground">
          Emite en {t.invoicingMode === 'holded' ? 'Holded' : 'la app'}
          {t.holdedEnabled && t.invoicingMode === 'app' ? ' · copia en Holded' : ''}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <span key={c.label} className={`rounded px-2 py-0.5 text-xs ${toneClass[c.tone]}`}>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
