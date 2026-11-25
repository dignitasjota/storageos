'use client';

import { CheckCircle2, Clock, ExternalLink, Loader2, PauseCircle } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type {
  AdminCustomDomainBlockDto,
  AdminCustomDomainDto,
  CustomDomainCheckDto,
} from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAdminCustomDomains, useCustomDomainAction } from '@/lib/admin/hooks';
import { useCheckCustomDomain } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatDateTime } from '@/lib/format';

const TENANT_STATUS_LABEL: Record<string, string> = {
  suspended: 'Suspendido',
  cancelled: 'De baja',
  trial: 'En prueba',
};

/** Mensaje corto de cada nombre comprobado: «raíz» o «con www». */
function hostLabel(purpose: 'primary' | 'alternate', host: string): string {
  return purpose === 'primary' ? host : `${host} (la otra forma)`;
}

/**
 * Dominios propios: pendientes de activar, activos y en pausa (su plan ya no
 * incluye la función). Activar comprueba el DNS, el https y el plan.
 */
export default function AdminCustomDomainsPage() {
  const domains = useAdminCustomDomains();
  const verify = useCustomDomainAction('verify');
  const revoke = useCustomDomainAction('revoke');
  const check = useCheckCustomDomain();
  const canEdit = useIsSuperadmin();
  const ask = useConfirm();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, CustomDomainCheckDto>>({});

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (domains.data ?? []).filter(
      (d) =>
        !q || d.customDomain.toLowerCase().includes(q) || d.tenantName.toLowerCase().includes(q),
    );
  }, [domains.data, search]);

  async function runCheck(tenantId: string) {
    try {
      const r = await check.mutateAsync(tenantId);
      setResults((prev) => ({ ...prev, [tenantId]: r }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo comprobar.');
    }
  }

  async function activate(d: AdminCustomDomainDto) {
    try {
      await verify.mutateAsync({ tenantId: d.tenantId });
      toast.success(`Activado ${d.customDomain}`);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'custom_domain_not_ready') {
        const block = err.body.details as AdminCustomDomainBlockDto | undefined;
        if (!canEdit) {
          toast.error(err.body.message);
          return;
        }
        const res = await ask({
          title: 'No se puede activar con seguridad',
          description: (
            <div className="space-y-2 text-sm">
              <p>{err.body.message}</p>
              {block && (
                <ul className="list-disc pl-5">
                  {block.featureMissing && <li>Su plan no incluye el dominio propio.</li>}
                  {block.hosts.map((h) => (
                    <li key={h.host}>
                      {hostLabel(h.purpose, h.host)}:{' '}
                      {h.pointsToPlatform ? 'apunta a la plataforma' : 'no apunta a la plataforma'}
                    </li>
                  ))}
                  {block.httpsOk === false && <li>No responde por https.</li>}
                </ul>
              )}
              <p>
                Si lo activas igualmente, los enlaces del tenant usarán un dominio que puede estar
                roto
                {block?.featureMissing
                  ? ' (y quedará en pausa mientras su plan no lo incluya)'
                  : ''}
                .
              </p>
            </div>
          ),
          confirmLabel: 'Activar igualmente',
          destructive: true,
        });
        if (!res) return;
        try {
          await verify.mutateAsync({ tenantId: d.tenantId, force: true });
          toast.success(`Activado ${d.customDomain} (sin comprobaciones)`);
        } catch (e2) {
          toast.error(e2 instanceof ApiError ? e2.body.message : 'Error');
        }
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function deactivate(d: AdminCustomDomainDto) {
    const res = await ask({
      title: `Desactivar ${d.customDomain}`,
      description: `La web de ${d.tenantName} deja de servirse en ese dominio y los enlaces de la reserva, la firma, el área de clientes y los correos vuelven a la dirección de la plataforma. Se le avisa por correo. Acuérdate de borrar su Proxy Host y su certificado en Nginx Proxy Manager.`,
      confirmLabel: 'Desactivar',
      destructive: true,
    });
    if (!res) return;
    try {
      await revoke.mutateAsync(d.tenantId);
      toast.success(`Desactivado ${d.customDomain}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const pending = rows.filter((d) => !d.verifiedAt && !d.pausedByPlan);
  const paused = rows.filter((d) => d.pausedByPlan);
  const active = rows.filter((d) => d.verifiedAt);

  const body = (d: AdminCustomDomainDto, mode: 'pending' | 'active' | 'paused') => {
    const result = results[d.tenantId];
    return (
      <div key={d.tenantId} className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {mode === 'active' ? (
                <a
                  href={`https://${d.customDomain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 break-all font-mono font-medium hover:underline"
                >
                  {d.customDomain} <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span className="break-all font-mono font-medium">{d.customDomain}</span>
              )}
              {TENANT_STATUS_LABEL[d.tenantStatus] && d.tenantStatus !== 'trial' && (
                <Badge variant="destructive">{TENANT_STATUS_LABEL[d.tenantStatus]}</Badge>
              )}
            </div>
            <div className="text-muted-foreground">
              <Link href={`/admin/tenants/${d.tenantId}`} className="hover:underline">
                {d.tenantName}
              </Link>{' '}
              · plan {d.planSlug}
              {d.tenantStatus === 'trial' && ' · en prueba'}
            </div>
            <div className="flex flex-wrap gap-1">
              {mode === 'pending' &&
                (d.dnsReadyAt ? (
                  <Badge variant="secondary">DNS listo desde el {formatDate(d.dnsReadyAt)}</Badge>
                ) : (
                  <Badge variant="outline">DNS sin comprobar</Badge>
                ))}
              {mode === 'pending' && !d.featureEnabled && (
                <Badge variant="destructive">Su plan no incluye dominio propio</Badge>
              )}
              {mode === 'paused' && (
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  En pausa: su plan no lo incluye
                </Badge>
              )}
              {mode !== 'pending' && d.checkOk === true && (
                <Badge variant="secondary">Responde</Badge>
              )}
              {mode !== 'pending' && d.checkOk === false && (
                <Badge variant="destructive">
                  {d.checkIssue === 'https' ? 'No responde por https' : 'Ya no apunta'}
                </Badge>
              )}
              {mode !== 'pending' && d.checkOk === null && (
                <Badge variant="outline">Sin comprobar</Badge>
              )}
            </div>
            {mode !== 'pending' && d.activatedAt && (
              <p className="text-xs text-muted-foreground">
                Activado el {formatDate(d.activatedAt)}
                {d.activatedByName ? ` por ${d.activatedByName}` : ''}
                {d.checkedAt ? ` · comprobado ${formatDateTime(d.checkedAt)}` : ''}
              </p>
            )}
            {mode === 'paused' && (
              <p className="text-xs text-muted-foreground">
                Los enlaces usan la dirección de TrasterOS. Se reactiva solo si recupera la función.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runCheck(d.tenantId)}
              disabled={check.isPending}
            >
              {mode === 'pending' ? 'Comprobar DNS' : 'Comprobar ahora'}
            </Button>
            {canEdit && mode === 'pending' && (
              <Button size="sm" onClick={() => void activate(d)} disabled={verify.isPending}>
                Activar
              </Button>
            )}
            {canEdit && mode !== 'pending' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void deactivate(d)}
                disabled={revoke.isPending}
              >
                Desactivar
              </Button>
            )}
          </div>
        </div>
        {result && (
          <div className="rounded border bg-muted/40 p-2 text-xs">
            <p className="mb-1 font-medium">
              {result.pointsToPlatform ? 'Responde' : 'No apunta aún'} (comprobado ahora)
            </p>
            <ul className="space-y-0.5">
              {result.hosts.map((h) => (
                <li key={h.host} className="break-all">
                  {h.pointsToPlatform ? '✓' : '✗'} {hostLabel(h.purpose, h.host)}
                  {!h.pointsToPlatform && (
                    <span className="text-muted-foreground">
                      {' '}
                      — responde {h.found.join(', ') || 'nada'} y debería ser{' '}
                      {result.expected.join(', ')}
                    </span>
                  )}
                </li>
              ))}
              {result.httpsOk !== undefined && result.httpsOk !== null && (
                <li>{result.httpsOk ? '✓ Responde por https' : '✗ No responde por https'}</li>
              )}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold">Dominios propios</h1>
        <p className="text-sm text-muted-foreground">
          Activa el dominio de un tenant cuando su DNS ya apunte a la plataforma y hayas creado el
          Proxy Host + certificado en Nginx Proxy Manager. Los activos se comprueban cada día y se
          avisa si dejan de responder.
        </p>
      </div>

      <Input
        placeholder="Buscar por dominio o tenant…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full text-base sm:w-72 sm:text-sm"
      />

      {domains.isError ? (
        <AdminError
          onRetry={() => void domains.refetch()}
          message="No se pudieron cargar los dominios."
        />
      ) : domains.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="size-4 text-amber-500" /> Pendientes de activar ({pending.length})
              </CardTitle>
              <CardDescription>
                Al activar se comprueba que el DNS apunta a la plataforma, que responde por https y
                que su plan incluye la función.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {pending.length === 0 && (
                <p className="text-sm text-muted-foreground">No hay dominios pendientes.</p>
              )}
              {pending.map((d) => body(d, 'pending'))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="size-4 text-green-500" /> Activos ({active.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {active.length === 0 && (
                <p className="text-sm text-muted-foreground">No hay dominios activos.</p>
              )}
              {active.map((d) => body(d, 'active'))}
            </CardContent>
          </Card>

          {paused.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <PauseCircle className="size-4 text-amber-500" /> En pausa por plan (
                  {paused.length})
                </CardTitle>
                <CardDescription>
                  Se activaron, pero su plan ya no incluye el dominio propio: los enlaces usan la
                  dirección de la plataforma y vuelven solos si recuperan la función.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {paused.map((d) => body(d, 'paused'))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
