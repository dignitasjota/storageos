'use client';

import {
  SEO_PROVIDER_LABELS,
  SEO_SISTRIX_DATA_TYPES,
  SEO_SISTRIX_DATA_TYPE_LABELS,
  SEO_SISTRIX_RUN_STATUS_LABELS,
  SEO_SISTRIX_WAIT_LABELS,
  SEO_SYNC_FREQUENCY_LABELS,
  type SeoSistrixDataType,
  type SeoSistrixRunDto,
  type SeoSistrixRunStatus,
  type SeoSistrixWorkspaceDto,
} from '@storageos/shared';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export const RUN_STATUS_CLASS: Record<SeoSistrixRunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Una tanda de SISTRIX en una línea (estado, progreso, motivo de la espera). */
export function SistrixRunRow({
  run,
  showProject = false,
  onCancel,
}: {
  run: SeoSistrixRunDto;
  showProject?: boolean;
  onCancel?: ((runId: string) => Promise<unknown>) | undefined;
}) {
  const active = run.status === 'queued' || run.status === 'running' || run.status === 'waiting';
  const cancel = async () => {
    try {
      await onCancel?.(run.id);
      toast.success('Tanda cancelada');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{SEO_SISTRIX_DATA_TYPE_LABELS[run.dataType]}</span>
          {showProject && run.projectName && (
            <span className="text-muted-foreground">· {run.projectName}</span>
          )}
          <span className={cn('rounded px-1.5 py-0.5 text-xs', RUN_STATUS_CLASS[run.status])}>
            {SEO_SISTRIX_RUN_STATUS_LABELS[run.status]}
          </span>
          {run.provider && run.provider !== 'gsc' && (
            <span className="text-xs text-muted-foreground">
              {SEO_PROVIDER_LABELS[run.provider]}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {run.itemsDone + run.itemsFailed}/{run.itemsTotal} consultas
          {run.itemsPending > 0 && run.itemsOverall
            ? ` · tanda parcial: ${run.itemsOverall - run.itemsPending} de ${run.itemsOverall} en esta vuelta, faltan ${run.itemsPending}`
            : ''}
          {run.itemsFailed > 0 ? ` · ${run.itemsFailed} con error` : ''}
          {run.creditsUsed > 0 ? ` · ${run.creditsUsed} créditos` : ''} ·{' '}
          {formatDateTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}
          {run.createdBy ? ` · ${run.createdBy}` : ''}
        </p>
        {run.status === 'waiting' && run.pausedReason && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {SEO_SISTRIX_WAIT_LABELS[run.pausedReason]}
            {run.pausedUntil ? ` (hasta ${formatDateTime(run.pausedUntil)})` : ''}
          </p>
        )}
        {run.error && <p className="break-words text-xs text-destructive">{run.error}</p>}
      </div>
      {active && onCancel && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => void cancel()}>
          <X className="mr-1 size-4" aria-hidden /> Cancelar
        </Button>
      )}
    </li>
  );
}

/** Cabecera de SISTRIX en un proyecto: de dónde salen los datos y «Sincronizar ahora». */
export function SistrixStatus({
  workspace,
  canEdit,
  onSync,
  onCancel,
}: {
  workspace: SeoSistrixWorkspaceDto;
  canEdit: boolean;
  onSync: (dataType: SeoSistrixDataType) => Promise<unknown>;
  onCancel: (runId: string) => Promise<unknown>;
}) {
  const [dataType, setDataType] = useState<SeoSistrixDataType>('visibility');
  const [pending, setPending] = useState(false);
  const active = workspace.runs.filter((r) => ['queued', 'running', 'waiting'].includes(r.status));
  const sync = async () => {
    setPending(true);
    try {
      await onSync(dataType);
      toast.success('En marcha. Los datos aparecerán al terminar.');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setPending(false);
    }
  };
  const routing = workspace.routing;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={workspace.available ? 'secondary' : 'outline'}>
          {workspace.pool === 'platform'
            ? workspace.usePlatformSistrix
              ? 'Conexión de SISTRIX de la plataforma'
              : 'SISTRIX de la plataforma'
            : 'Tu clave de API de SISTRIX'}
        </Badge>
        {routing.provider ? (
          <span className="text-muted-foreground">
            Ahora se pide por {SEO_PROVIDER_LABELS[routing.provider]}.
          </span>
        ) : routing.waitReason ? (
          <span className="text-amber-700 dark:text-amber-300">
            {SEO_SISTRIX_WAIT_LABELS[routing.waitReason]}.
          </span>
        ) : null}
      </div>
      {workspace.unavailableReason && (
        <p className="text-sm text-muted-foreground">{workspace.unavailableReason}</p>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {SEO_SISTRIX_DATA_TYPES.map((t) => (
          <div key={t} className="flex justify-between gap-2 border-b py-1 last:border-0">
            <dt className="text-muted-foreground">{SEO_SISTRIX_DATA_TYPE_LABELS[t]}</dt>
            <dd className="text-right">
              {workspace.lastSync[t] ? formatDateTime(workspace.lastSync[t].at) : 'Nunca'} ·{' '}
              <span className="text-muted-foreground">
                {SEO_SYNC_FREQUENCY_LABELS[workspace.frequencies[t]]}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {canEdit && workspace.available && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={dataType} onValueChange={(v) => setDataType(v as SeoSistrixDataType)}>
            <SelectTrigger className="sm:w-72" aria-label="Qué sincronizar">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEO_SISTRIX_DATA_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {SEO_SISTRIX_DATA_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void sync()} disabled={pending}>
            {pending ? (
              <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="mr-1 size-4" aria-hidden />
            )}
            Sincronizar ahora
          </Button>
        </div>
      )}
      {active.length > 0 && (
        <ul className="divide-y rounded-md border px-3">
          {active.map((r) => (
            <SistrixRunRow key={r.id} run={r} onCancel={canEdit ? onCancel : undefined} />
          ))}
        </ul>
      )}
    </div>
  );
}
