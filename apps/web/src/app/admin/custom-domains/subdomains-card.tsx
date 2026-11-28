'use client';

import { CheckCircle2, Globe, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminSubdomainCheckDto, AdminTenantSubdomainDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminSubdomains, useCheckSubdomain, useSetSubdomainReady } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

/**
 * Subdominios `<slug>.<plataforma>` pendientes de crear en el proxy (SEO web
 * D4). El certificado se crea a mano en Nginx Proxy Manager (desafío HTTP): aquí
 * se guía el paso, se comprueba que responda y se marca como hecho.
 */
export function SubdomainsCard() {
  const subdomains = useAdminSubdomains();
  const ready = useSetSubdomainReady();
  const check = useCheckSubdomain();
  const isSuperadmin = useIsSuperadmin();
  const [results, setResults] = useState<Record<string, AdminSubdomainCheckDto>>({});

  const rows = subdomains.data ?? [];

  async function runCheck(row: AdminTenantSubdomainDto) {
    try {
      const result = await check.mutateAsync(row.tenantId);
      setResults((r) => ({ ...r, [row.tenantId]: result }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo comprobar el subdominio');
    }
  }

  async function markReady(row: AdminTenantSubdomainDto) {
    try {
      await ready.mutateAsync({ tenantId: row.tenantId, ready: true });
      toast.success(`${row.host} marcado como creado`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo marcar el subdominio');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4 text-slate-500" /> Subdominios de la plataforma
          {rows.length > 0 && <Badge variant="secondary">{rows.length} por crear</Badge>}
        </CardTitle>
        <CardDescription>
          Cada negocio tiene su dirección <strong>&lt;identificador&gt;.trasteros.pro</strong>, que
          no se indexa. Para que responda hay que crear su Proxy Host en Nginx Proxy Manager con su
          certificado: pasos en <em>docs/DEPLOYMENT.md §214</em>. Cuando responda, pulsa «Hecho».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {subdomains.isError && (
          <AdminError
            onRetry={() => void subdomains.refetch()}
            message="No se pudo cargar la lista."
          />
        )}
        {!subdomains.isError && subdomains.isLoading && (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        )}
        {!subdomains.isLoading && !subdomains.isError && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay subdominios pendientes.</p>
        )}
        {rows.map((row) => {
          const result = results[row.tenantId];
          return (
            <div
              key={row.tenantId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {row.tenantName} <span className="text-muted-foreground">({row.tenantSlug})</span>
                </p>
                <p className="truncate font-mono text-xs">{row.host}</p>
                <p className="text-xs text-muted-foreground">
                  {row.redirectHost
                    ? `Redirige a ${row.redirectHost} (dominio propio verificado).`
                    : 'Sin dominio propio: aquí se sirve la web del negocio, sin indexar.'}
                </p>
                {result && (
                  <p
                    className={`flex items-center gap-1 text-xs ${result.ok ? 'text-emerald-600' : 'text-red-600'}`}
                  >
                    {result.ok ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <XCircle className="size-3.5" />
                    )}
                    {result.detail}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={check.isPending}
                  onClick={() => void runCheck(row)}
                >
                  {check.isPending && check.variables === row.tenantId ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : null}
                  Comprobar
                </Button>
                <Button
                  size="sm"
                  disabled={!isSuperadmin || ready.isPending}
                  title={isSuperadmin ? undefined : 'Solo el superadmin lo marca como hecho'}
                  onClick={() => void markReady(row)}
                >
                  Hecho
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
