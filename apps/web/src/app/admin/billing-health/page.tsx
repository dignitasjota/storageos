'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CertificatesSection } from './certificates-section';
import { IssuesSection } from './issues-section';
import { NoticeDialog, type NoticeTarget } from './notice-dialog';
import { OtherProblemsSection } from './other-problems-section';
import { StuckSection } from './stuck-section';
import { TenantsSection } from './tenants-section';

import type { AdminTenantBillingHealthDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminBillingHealth } from '@/lib/admin/hooks';
import { useAdminAeatAction } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatDateTime } from '@/lib/format';

const AEAT_LABEL: Record<string, string> = {
  rejected: 'Rechazada',
  error: 'Error',
  pending: 'Sin respuesta',
  accepted_with_warnings: 'Aceptada con errores',
};

const MODE_LABEL: Record<string, string> = {
  stub: 'Simulado',
  sandbox: 'Pruebas de la AEAT',
  production: 'Real',
};

/** «1 rechazada» / «3 rechazadas». */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Problemas de facturación de los tenants: facturas rechazadas, con errores,
 * sin respuesta o sin enviar a la AEAT, envíos de Holded para revisar y
 * certificados que faltan o caducan.
 */
export default function AdminBillingHealthPage() {
  const health = useAdminBillingHealth();
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<NoticeTarget | null>(null);

  const tenants = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (health.data?.tenants ?? []).filter(
      (t) =>
        (!onlyIssues || t.issues > 0) &&
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

  const { invoices, invoicesTotal, aeatMode } = health.data;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Problemas de facturación</h1>
        <p className="text-sm text-muted-foreground">
          Veri*Factu, Holded y certificados de la AEAT de cada negocio. Una factura rechazada, con
          errores, sin enviar o sin respuesta de la AEAT, o un certificado que falta o ha caducado,
          impide que el tenant cumpla con Veri*Factu.{' '}
          <span className="whitespace-nowrap">
            Envío a la AEAT: <strong>{MODE_LABEL[aeatMode] ?? aeatMode}</strong>.
          </span>
        </p>
      </div>

      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">Resumen</TabsTrigger>
          <TabsTrigger value="issues">Facturas</TabsTrigger>
          <TabsTrigger value="stuck">Envíos atascados</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="certificates">Certificados</TabsTrigger>
          <TabsTrigger value="other">Otros</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="mt-4 space-y-6">
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
                Con «Solo con problemas» desmarcado se ven también los tenants con Veri*Factu
                activado, certificado o Holded que van bien.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {tenants.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  {onlyIssues ? 'Ningún tenant tiene problemas de facturación.' : 'Sin resultados.'}
                </p>
              ) : (
                tenants.map((t) => <TenantRow key={t.tenantId} t={t} aeatMode={aeatMode} />)
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Facturas con problemas en la AEAT</CardTitle>
              <CardDescription>
                Rechazadas, con error, aceptadas con errores, sin enviar o sin respuesta tras 48 h.
                {invoicesTotal > invoices.length
                  ? ` Se muestran las ${invoices.length} más recientes de ${invoicesTotal}.`
                  : ''}
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
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Emitida {formatDate(i.issueDate)}
                      </span>
                      <Badge
                        variant={
                          i.unsent ||
                          i.aeatStatus === 'pending' ||
                          i.aeatStatus === 'accepted_with_warnings'
                            ? 'secondary'
                            : 'destructive'
                        }
                      >
                        {i.unsent ? 'Sin enviar' : (AEAT_LABEL[i.aeatStatus] ?? i.aeatStatus)}
                      </Badge>
                      <AeatButtons invoiceId={i.invoiceId} invoiceNumber={i.invoiceNumber} />
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="issues" className="mt-4">
          <IssuesSection />
        </TabsContent>
        <TabsContent value="stuck" className="mt-4">
          <StuckSection />
        </TabsContent>
        <TabsContent value="tenants" className="mt-4">
          <TenantsSection canNotify onNotice={setNotice} />
        </TabsContent>
        <TabsContent value="certificates" className="mt-4">
          <CertificatesSection canNotify onNotice={setNotice} />
        </TabsContent>
        <TabsContent value="other" className="mt-4">
          <OtherProblemsSection />
        </TabsContent>
      </Tabs>
      <NoticeDialog target={notice} onClose={() => setNotice(null)} />
    </div>
  );
}

function TenantRow({ t, aeatMode }: { t: AdminTenantBillingHealthDto; aeatMode: string }) {
  const chips: { label: string; tone: 'red' | 'amber' | 'muted' }[] = [];
  if (t.aeatRejected > 0)
    chips.push({ label: plural(t.aeatRejected, 'rechazada', 'rechazadas'), tone: 'red' });
  if (t.aeatError > 0)
    chips.push({ label: plural(t.aeatError, 'con error', 'con error'), tone: 'red' });
  if (t.aeatWarnings > 0)
    chips.push({
      label: `${plural(t.aeatWarnings, 'aceptada', 'aceptadas')} con errores (hay que subsanar)`,
      tone: 'amber',
    });
  if (t.aeatPendingStale > 0)
    chips.push({ label: `${t.aeatPendingStale} sin respuesta >48 h`, tone: 'amber' });
  if (t.unsentRecords > 0)
    chips.push({
      label: `${plural(t.unsentRecords, 'registro sin enviar', 'registros sin enviar')}${
        t.unsentSince ? ` desde el ${formatDate(t.unsentSince)}` : ''
      }`,
      tone: 'red',
    });
  if (t.failedSubmissions > 0)
    chips.push({
      label: `${plural(t.failedSubmissions, 'envío fallido', 'envíos fallidos')}${
        t.lastSubmissionAt ? ` (último ${formatDateTime(t.lastSubmissionAt)})` : ''
      }`,
      tone: 'red',
    });
  if (t.holdedReview > 0)
    chips.push({ label: `Holded: ${t.holdedReview} para revisar`, tone: 'amber' });
  if (t.certificateMissing) {
    chips.push({ label: 'Sin certificado', tone: 'red' });
  } else if (t.certificateDaysLeft !== null) {
    if (t.certificateDaysLeft <= 0)
      chips.push({
        label: `Certificado caducado (${formatDate(t.certificateValidTo)})`,
        tone: 'red',
      });
    else if (t.certificateDaysLeft <= 30)
      chips.push({ label: `Certificado caduca en ${t.certificateDaysLeft} d`, tone: 'amber' });
    else
      chips.push({ label: `Certificado hasta ${formatDate(t.certificateValidTo)}`, tone: 'muted' });
  }
  for (const c of t.ownerCertificates) {
    const who = c.ownerName ?? 'propietario';
    if (c.daysLeft <= 0)
      chips.push({
        label: `Certificado de ${who} caducado (${formatDate(c.validTo)})`,
        tone: 'red',
      });
    else if (c.daysLeft <= 30)
      chips.push({ label: `Certificado de ${who} caduca en ${c.daysLeft} d`, tone: 'amber' });
  }
  if (t.lastSentAt)
    chips.push({ label: `Último envío ${formatDate(t.lastSentAt)}`, tone: 'muted' });
  if (t.verifactuEnabled && chips.every((c) => c.tone === 'muted'))
    chips.push({ label: 'Todo en orden', tone: 'muted' });

  const toneClass = {
    red: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    muted: 'bg-muted text-muted-foreground',
  };
  const errorDetail = t.unsentLastError ?? t.lastSubmissionError;
  return (
    <div className="space-y-1 rounded-md border p-2 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Link
            href={`/admin/tenants/${t.tenantId}?tab=config`}
            className="font-medium hover:underline"
          >
            {t.tenantName}
          </Link>
          <span className="ml-2 text-xs text-muted-foreground">
            Emite en {t.invoicingMode === 'holded' ? 'Holded' : 'la app'}
            {t.holdedEnabled && t.invoicingMode === 'app' ? ' · copia en Holded' : ''}
            {t.verifactuEnabled && t.invoicingMode === 'app'
              ? ` · Veri*Factu ${(MODE_LABEL[aeatMode] ?? aeatMode).toLowerCase()}`
              : ''}
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
      {errorDetail && (t.unsentRecords > 0 || t.failedSubmissions > 0) && (
        <p className="break-words text-xs text-muted-foreground">Último error: {errorDetail}</p>
      )}
    </div>
  );
}

/** Consultar el estado en la AEAT o volver a enviar la factura (esto último, superadmin y con motivo). */
function AeatButtons({
  invoiceId,
  invoiceNumber,
}: {
  invoiceId: string;
  invoiceNumber: string | null;
}) {
  const canEdit = useIsSuperadmin();
  const ask = useConfirm();
  const refresh = useAdminAeatAction('refresh-aeat');
  const resend = useAdminAeatAction('resend-aeat');
  async function runRefresh() {
    try {
      const r = await refresh.mutateAsync(invoiceId);
      toast.success(r.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar.');
    }
  }
  async function runResend() {
    const res = await ask({
      title: `Reenviar ${invoiceNumber ?? 'la factura'} a la AEAT`,
      description:
        'Se vuelve a enviar el registro de la factura. Si estaba rechazada, se crea una subsanación en nombre del tenant. Queda anotado en su historial con tu motivo.',
      confirmLabel: 'Reenviar',
      input: { label: 'Motivo (obligatorio)', required: true },
    });
    if (!res) return;
    const reason = res.value.trim();
    if (reason.length < 3) {
      toast.error('Indica el motivo (mínimo 3 caracteres).');
      return;
    }
    try {
      const r = await resend.mutateAsync({ invoiceId, reason });
      toast.success(r.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar.');
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        disabled={refresh.isPending}
        onClick={() => void runRefresh()}
      >
        Consultar AEAT
      </Button>
      {canEdit && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={resend.isPending}
          onClick={() => void runResend()}
        >
          Reenviar
        </Button>
      )}
    </>
  );
}
