'use client';

import {
  SEO_SYNC_KIND_LABELS,
  SEO_SYNC_STATUS_LABELS,
  type SeoSyncRunDto,
  type SeoSyncStatus,
} from '@storageos/shared';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { seoErrorMessage } from './seo-errors';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount, formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_CLASS: Record<SeoSyncStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Historial de descargas de Search Console del proyecto. */
export function SeoRunsCard({
  runs,
  isLoading,
  isError,
  onRetry,
  canEdit,
  onCancel,
}: {
  runs: SeoSyncRunDto[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  canEdit: boolean;
  onCancel: (runId: string) => Promise<unknown>;
}) {
  const cancel = async (id: string) => {
    try {
      await onCancel(id);
      toast.success('Descarga cancelada');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Descargas</CardTitle>
        <CardDescription>
          Cada día a las 07:00 se vuelven a descargar los últimos 5 días (Google corrige los datos
          recientes).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <SectionError onRetry={onRetry} />
        ) : isLoading || !runs ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no se ha descargado nada.</p>
        ) : (
          <ul className="divide-y">
            {runs.map((r) => {
              const active = r.status === 'queued' || r.status === 'running';
              return (
                <li
                  key={r.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{SEO_SYNC_KIND_LABELS[r.kind]}</span>
                      <Badge className={cn('border-transparent', STATUS_CLASS[r.status])}>
                        {SEO_SYNC_STATUS_LABELS[r.status]}
                      </Badge>
                      {r.domain && (
                        <span className="break-all text-xs text-muted-foreground">{r.domain}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(r.createdAt)}
                      {r.rangeFrom && r.rangeTo
                        ? ` · del ${formatDate(r.rangeFrom)} al ${formatDate(r.rangeTo)}`
                        : ''}
                      {` · ${r.daysDone}/${r.daysTotal} días · ${formatCount(r.rows)} filas`}
                      {r.createdBy ? ` · ${r.createdBy}` : ' · automática'}
                    </p>
                    {r.error && <p className="text-xs text-red-700 dark:text-red-400">{r.error}</p>}
                  </div>
                  {canEdit && active && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => void cancel(r.id)}
                    >
                      <X className="mr-1 size-4" aria-hidden /> Cancelar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
