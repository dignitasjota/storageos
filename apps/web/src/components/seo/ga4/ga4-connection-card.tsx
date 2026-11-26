'use client';

import { BarChart3, Copy, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  type Ga4AiScope,
  useConnectSeoGa4,
  useDisconnectSeoGa4,
  useSeoGa4Settings,
  useSyncSeoGa4,
} from '@/lib/seo-advanced/ga4-ai-hooks';

/**
 * Ajustes → Google Analytics (PR 12): la propiedad de GA4 (Data API) del
 * proyecto. En un negocio que ya conectó GA4 en Marketing, se reutiliza esa
 * conexión sin pedirla otra vez.
 */
export function SeoGa4ConnectionCard({ scope, canEdit }: { scope: Ga4AiScope; canEdit: boolean }) {
  const q = useSeoGa4Settings(scope);
  const connect = useConnectSeoGa4(scope);
  const disconnect = useDisconnectSeoGa4(scope);
  const sync = useSyncSeoGa4(scope);
  const confirm = useConfirm();
  const [propertyId, setPropertyId] = useState('');
  const d = q.data;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const copyEmail = async () => {
    if (!d?.serviceAccountEmail) return;
    try {
      await navigator.clipboard.writeText(d.serviceAccountEmail);
      toast.success('Correo copiado');
    } catch {
      toast.error('No se ha podido copiar');
    }
  };

  return (
    <Card id="ga4" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="size-5" aria-hidden /> Google Analytics
        </CardTitle>
        <CardDescription>
          Las visitas que llegan desde Google (sin anuncios) por la página por la que entraron:
          sesiones, interacción y eventos clave. Se cruzan con Search Console en «Rendimiento».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isError ? (
          <SectionError onRetry={() => void q.refetch()} />
        ) : !d ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : d.propertyId ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Propiedad</span>
              <span className="font-mono">{d.propertyId}</span>
              {d.source === 'marketing' && <Badge variant="secondary">La de Marketing</Badge>}
              {d.status === 'connected' && (
                <Badge className="bg-green-600 text-white hover:bg-green-600">Conectado</Badge>
              )}
              {d.status === 'pending' && (
                <Badge variant="outline">
                  <Loader2 className="mr-1 size-3 animate-spin" aria-hidden /> Descargando
                </Badge>
              )}
              {d.status === 'error' && <Badge variant="destructive">Con error</Badge>}
            </div>
            {d.lastError && (
              <p className="break-words text-sm text-red-700 dark:text-red-400">{d.lastError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {d.dataFrom && d.dataUntil
                ? `Datos del ${formatDate(d.dataFrom)} al ${formatDate(d.dataUntil)}. `
                : d.status === 'pending'
                  ? 'Descargando los últimos 16 meses: puede tardar unos minutos. '
                  : ''}
              {d.lastSyncedAt ? `Última descarga: ${formatDateTime(d.lastSyncedAt)}.` : ''} Cada día
              se descargan los últimos días.
            </p>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sync.isPending || d.status === 'pending'}
                  onClick={() => void run(() => sync.mutateAsync(), 'Descarga en marcha')}
                >
                  <RefreshCw className="mr-1 size-4" aria-hidden /> Descargar ahora
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Quitar Google Analytics',
                      description:
                        'Se borra lo descargado de este proyecto. La propiedad de Google Analytics no se toca.',
                      confirmLabel: 'Quitar',
                      destructive: true,
                    });
                    if (ok) await run(() => disconnect.mutateAsync(), 'Quitado');
                  }}
                >
                  <Unplug className="mr-1 size-4" aria-hidden /> Quitar
                </Button>
              </div>
            )}
          </div>
        ) : !d.available ? (
          <p className="text-sm text-muted-foreground">
            La conexión con Google todavía no está disponible en la plataforma.
          </p>
        ) : (
          <div className="space-y-4">
            {d.marketing?.connected && (
              <div className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Ya tienes Google Analytics conectado en Marketing (propiedad{' '}
                  <span className="font-mono">{d.marketing.propertyId}</span>).
                </span>
                {canEdit && (
                  <Button
                    size="sm"
                    disabled={connect.isPending}
                    onClick={() =>
                      void run(
                        () => connect.mutateAsync({ source: 'marketing' }),
                        'Conectado: descargando los últimos 16 meses',
                      )
                    }
                  >
                    Usar esa conexión
                  </Button>
                )}
              </div>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                En Google Analytics, entra en Administrar → Gestión del acceso a la propiedad y
                añade este correo con el rol «Lector»:
                {d.serviceAccountEmail && (
                  <span className="mt-1 flex items-center gap-1">
                    <span className="break-all font-mono text-xs text-foreground">
                      {d.serviceAccountEmail}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label="Copiar el correo"
                      onClick={() => void copyEmail()}
                    >
                      <Copy className="size-3.5" aria-hidden />
                    </Button>
                  </span>
                )}
              </li>
              <li>
                Copia el número de la propiedad: Administrar → Detalles de la propiedad → «ID de la
                propiedad» (solo números; no es el «G-…» de la web).
              </li>
              {scope.kind === 'tenant' && (
                <li>
                  Si no es la de Marketing, ten puesto tu ID de medición (G-…) en Configuración →
                  Marca y SEO: así se comprueba que la propiedad es de tu web.
                </li>
              )}
            </ol>
            {canEdit && (
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => connect.mutateAsync({ source: 'own', propertyId: propertyId.trim() }),
                    'Conectado: descargando los últimos 16 meses',
                  );
                }}
              >
                <div className="w-full space-y-1 sm:max-w-xs">
                  <Label htmlFor="ga4-property">ID de la propiedad</Label>
                  <Input
                    id="ga4-property"
                    inputMode="numeric"
                    placeholder="123456789"
                    value={propertyId}
                    onChange={(e) => setPropertyId(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={connect.isPending || propertyId.trim().length < 6}>
                  {connect.isPending && (
                    <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                  )}
                  Conectar
                </Button>
              </form>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
