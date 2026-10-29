'use client';

import { CheckCircle2, Clock, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminCustomDomains, useCustomDomainAction } from '@/lib/admin/hooks';
import { useCheckCustomDomain } from '@/lib/admin/tenant-tools-hooks';
import { ApiError } from '@/lib/auth/api';

export default function AdminCustomDomainsPage() {
  const domains = useAdminCustomDomains();
  const verify = useCustomDomainAction('verify');
  const revoke = useCustomDomainAction('revoke');
  const check = useCheckCustomDomain();

  async function runCheck(tenantId: string) {
    try {
      const r = await check.mutateAsync(tenantId);
      if (r.pointsToPlatform) toast.success(`${r.domain} ya apunta a la plataforma.`);
      else
        toast.error(
          `${r.domain} todavía no apunta: responde ${r.found.join(', ') || 'nada'} y debería ser ${r.expected.join(', ')}.`,
        );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo comprobar.');
    }
  }

  async function run(action: 'verify' | 'revoke', tenantId: string, domain: string) {
    const mut = action === 'verify' ? verify : revoke;
    try {
      await mut.mutateAsync(tenantId);
      toast.success(action === 'verify' ? `Activado ${domain}` : `Desactivado ${domain}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const rows = domains.data ?? [];
  const pending = rows.filter((d) => !d.verifiedAt);
  const active = rows.filter((d) => d.verifiedAt);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold">Dominios propios</h1>
        <p className="text-sm text-muted-foreground">
          Activa el dominio de un tenant cuando su DNS ya apunte a la plataforma y hayas creado el
          Proxy Host + certificado en Nginx Proxy Manager.
        </p>
      </div>

      {domains.isLoading ? (
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
                Verifica que <code>https://&lt;dominio&gt;</code> ya resuelve al VPS antes de
                activar.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {pending.length === 0 && (
                <p className="text-sm text-muted-foreground">No hay dominios pendientes.</p>
              )}
              {pending.map((d) => (
                <div
                  key={d.tenantId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                >
                  <div className="text-sm">
                    <span className="font-mono font-medium">{d.customDomain}</span>
                    <span className="ml-2 text-muted-foreground">
                      {d.tenantName} · {d.planSlug}
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.dnsReadyAt ? (
                        <Badge variant="secondary">
                          DNS listo desde el {new Date(d.dnsReadyAt).toLocaleDateString('es-ES')}
                        </Badge>
                      ) : (
                        <Badge variant="outline">DNS sin comprobar</Badge>
                      )}
                      {!d.featureEnabled && (
                        <Badge variant="destructive">Su plan no incluye dominio propio</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void runCheck(d.tenantId)}
                      disabled={check.isPending}
                    >
                      Comprobar DNS
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => run('verify', d.tenantId, d.customDomain)}
                      disabled={verify.isPending}
                    >
                      Activar
                    </Button>
                  </div>
                </div>
              ))}
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
              {active.map((d) => (
                <div
                  key={d.tenantId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                >
                  <div className="text-sm">
                    <a
                      href={`https://${d.customDomain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono font-medium hover:underline"
                    >
                      {d.customDomain} <ExternalLink className="size-3" />
                    </a>
                    <span className="ml-2 text-muted-foreground">{d.tenantName}</span>
                    <Badge variant="secondary" className="ml-2">
                      activo
                    </Badge>
                    {!d.featureEnabled && (
                      <Badge variant="destructive" className="ml-2">
                        Su plan ya no lo incluye
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => run('revoke', d.tenantId, d.customDomain)}
                    disabled={revoke.isPending}
                  >
                    Desactivar
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
