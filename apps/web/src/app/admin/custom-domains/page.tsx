'use client';

import { CheckCircle2, Clock, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminCustomDomains, useCustomDomainAction } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export default function AdminCustomDomainsPage() {
  const domains = useAdminCustomDomains();
  const verify = useCustomDomainAction('verify');
  const revoke = useCustomDomainAction('revoke');

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
                  </div>
                  <Button
                    size="sm"
                    onClick={() => run('verify', d.tenantId, d.customDomain)}
                    disabled={verify.isPending}
                  >
                    Activar
                  </Button>
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
