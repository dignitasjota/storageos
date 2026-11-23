'use client';

import { Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { AdminTenantDataExportDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  downloadDataExport,
  useRequestDataExport,
  useTenantDataExports,
} from '@/lib/admin/tenant-lifecycle-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';

const size = (bytes: number | null) =>
  bytes === null
    ? '—'
    : bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const when = (iso: string) => new Date(iso).toLocaleString('es-ES');

async function download(tenantId: string, exportId: string) {
  try {
    const { url } = await downloadDataExport(tenantId, exportId);
    window.location.href = url;
  } catch {
    toast.error('No se pudo descargar: puede que el fichero ya se haya borrado.');
  }
}

/**
 * Pide una exportación (se genera en segundo plano) y la descarga en cuanto
 * está lista; `onDone` se llama al descargarla.
 */
export function ExportNowButton({
  tenantId,
  onDone,
  label = 'Exportar los datos (Excel)',
}: {
  tenantId: string;
  onDone?: () => void;
  label?: string;
}) {
  const request = useRequestDataExport(tenantId);
  const [waiting, setWaiting] = useState<string | null>(null);
  const list = useTenantDataExports(tenantId, waiting !== null);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!waiting) return;
    const row = list.data?.find((e) => e.id === waiting);
    if (!row || row.status === 'pending' || handled.current === waiting) return;
    handled.current = waiting;
    setWaiting(null);
    if (row.status === 'done') {
      toast.success('Exportación lista. Se descarga el Excel.');
      void download(tenantId, row.id);
      onDone?.();
    } else {
      toast.error(`No se pudo exportar: ${row.error ?? 'error desconocido'}`);
    }
  }, [list.data, waiting, tenantId, onDone]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={request.isPending || waiting !== null}
      onClick={() =>
        request.mutate(undefined, {
          onSuccess: (r) => {
            setWaiting(r.id);
            toast.message(
              'Preparando la exportación… puedes seguir trabajando; te avisamos al terminar.',
            );
          },
          onError: () => toast.error('No se pudo pedir la exportación.'),
        })
      }
    >
      {request.isPending || waiting ? (
        <Loader2 className="mr-1 size-4 animate-spin" />
      ) : (
        <Download className="mr-1 size-4" />
      )}
      {waiting ? 'Preparando el Excel…' : label}
    </Button>
  );
}

const STATUS: Record<
  AdminTenantDataExportDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' }
> = {
  pending: { label: 'Preparando', variant: 'secondary' },
  done: { label: 'Lista', variant: 'default' },
  failed: { label: 'Falló', variant: 'destructive' },
};

/** Historial de exportaciones del tenant (quién, cuándo, tamaño) con descarga. */
export function TenantExportsCard({ tenantId }: { tenantId: string }) {
  const list = useTenantDataExports(tenantId);
  const canDownload = useIsSuperadmin();
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Exportaciones de sus datos</CardTitle>
        {canDownload && <ExportNowButton tenantId={tenantId} label="Nueva exportación" />}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          Un Excel con una hoja por tipo de dato (sin contraseñas, PIN ni cuentas completas). El
          fichero se borra a los 2 días.
        </p>
        {list.isError ? (
          <AdminError onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (list.data ?? []).length === 0 ? (
          <p className="text-muted-foreground">Aún no se ha exportado.</p>
        ) : (
          <ul className="divide-y">
            {(list.data ?? []).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS[e.status].variant}>{STATUS[e.status].label}</Badge>
                    <span>{when(e.createdAt)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {e.requestedByName ?? '—'} · {size(e.fileBytes)}
                    {e.counts
                      ? ` · ${Object.values(e.counts).reduce((s, n) => s + n, 0)} filas en ${Object.keys(e.counts).length} hojas`
                      : ''}
                    {e.error ? ` · ${e.error}` : ''}
                  </p>
                </div>
                {e.status === 'done' && canDownload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={e.expired}
                    title={e.expired ? 'Ya se ha borrado (dura 2 días)' : undefined}
                    onClick={() => void download(tenantId, e.id)}
                  >
                    <Download className="mr-1 size-4" />
                    {e.expired ? 'Borrado' : 'Descargar'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
