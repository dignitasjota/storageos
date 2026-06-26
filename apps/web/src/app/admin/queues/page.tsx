'use client';

import { CheckCircle2, Loader2, RotateCw, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAdminQueues,
  useAdminSystemHealth,
  useQueueFailedAction,
  type AdminQueueStatus,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES');
}

export default function AdminQueuesPage() {
  const queues = useAdminQueues();
  const health = useAdminSystemHealth();
  const retry = useQueueFailedAction('retry-failed');
  const clean = useQueueFailedAction('clean-failed');

  async function onRetry(name: string) {
    try {
      const res = await retry.mutateAsync(name);
      toast.success(`${res.retried ?? 0} job(s) reencolados en «${name}».`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reintentar.');
    }
  }

  async function onClean(name: string) {
    if (!window.confirm(`¿Eliminar los jobs fallidos de «${name}»? No se puede deshacer.`)) return;
    try {
      const res = await clean.mutateAsync(name);
      toast.success(`${res.cleaned ?? 0} job(s) eliminados de «${name}».`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo limpiar.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sistema y colas</h1>
        <p className="text-sm text-muted-foreground">
          Salud de la infraestructura y estado de las colas de background (refresco cada 15s).
        </p>
      </div>

      {/* Salud del sistema */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Salud del sistema</h2>
        {health.isLoading || !health.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {health.data.services.map((s) => {
              const up = s.status === 'up';
              return (
                <Card key={s.key} className={up ? '' : 'border-destructive/50'}>
                  <CardContent className="flex items-start gap-3 p-4">
                    {up ? (
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                    ) : (
                      <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.label}</span>
                        <Badge variant={up ? 'secondary' : 'destructive'}>
                          {up ? 'Operativo' : 'Caído'}
                        </Badge>
                      </div>
                      {s.latencyMs !== null && (
                        <div className="text-xs text-muted-foreground">{s.latencyMs} ms</div>
                      )}
                      {s.detail && (
                        <div
                          className="mt-0.5 truncate text-xs text-muted-foreground"
                          title={s.detail}
                        >
                          {s.detail}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Colas */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground">Colas BullMQ</h2>
        {queues.isLoading || !queues.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cola</TableHead>
                      <TableHead className="text-right">En espera</TableHead>
                      <TableHead className="text-right">Activos</TableHead>
                      <TableHead className="text-right">Programados</TableHead>
                      <TableHead className="text-right">Fallidos</TableHead>
                      <TableHead className="text-right">Completados</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queues.data.map((q) => (
                      <TableRow key={q.name}>
                        <TableCell className="font-mono text-sm">{q.name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {q.counts.waiting}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{q.counts.active}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {q.counts.delayed}
                        </TableCell>
                        <TableCell className="text-right">
                          {q.counts.failed > 0 ? (
                            <Badge variant="destructive">{q.counts.failed}</Badge>
                          ) : (
                            <span className="tabular-nums">0</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {q.counts.completed}
                        </TableCell>
                        <TableCell className="text-right">
                          {q.counts.failed > 0 ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={retry.isPending}
                                onClick={() => onRetry(q.name)}
                              >
                                <RotateCw className="mr-1 size-3.5" /> Reintentar
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={clean.isPending}
                                onClick={() => onClean(q.name)}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {queues.data
              .filter((q) => q.recentFailed.length > 0)
              .map((q) => (
                <FailedJobsCard key={q.name} queue={q} />
              ))}
            {queues.data.every((q) => q.recentFailed.length === 0) && (
              <p className="text-sm text-muted-foreground">Sin jobs fallidos recientes. 🎉</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function FailedJobsCard({ queue }: { queue: AdminQueueStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base">{queue.name} — últimos fallos</CardTitle>
        <CardDescription>Máximo 10 más recientes.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Motivo</TableHead>
              <TableHead className="text-right">Intentos</TableHead>
              <TableHead className="text-right">Fecha</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.recentFailed.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="font-mono text-xs">
                  {job.name} <span className="text-muted-foreground">#{job.id}</span>
                </TableCell>
                <TableCell className="max-w-md truncate text-xs" title={job.failedReason ?? ''}>
                  {job.failedReason ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">{job.attemptsMade}</TableCell>
                <TableCell className="text-right text-xs">{formatDate(job.timestamp)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
