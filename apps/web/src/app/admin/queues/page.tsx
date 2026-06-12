'use client';

import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminQueues, type AdminQueueStatus } from '@/lib/admin/hooks';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES');
}

export default function AdminQueuesPage() {
  const queues = useAdminQueues();

  if (queues.isLoading || !queues.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const withFailures = queues.data.filter((q) => q.recentFailed.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Colas BullMQ</h1>
        <p className="text-sm text-muted-foreground">
          Estado de las colas de background (se refresca cada 15s). Los jobs fallidos se retienen 30
          días en Redis.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Counts por cola</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cola</TableHead>
                <TableHead className="text-right">En espera</TableHead>
                <TableHead className="text-right">Activos</TableHead>
                <TableHead className="text-right">Programados</TableHead>
                <TableHead className="text-right">Fallidos</TableHead>
                <TableHead className="text-right">Completados</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.data.map((q) => (
                <TableRow key={q.name}>
                  <TableCell className="font-mono text-sm">{q.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.counts.waiting}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.counts.active}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.counts.delayed}</TableCell>
                  <TableCell className="text-right">
                    {q.counts.failed > 0 ? (
                      <Badge variant="destructive">{q.counts.failed}</Badge>
                    ) : (
                      <span className="tabular-nums">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.counts.completed}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {withFailures.map((q) => (
        <FailedJobsCard key={q.name} queue={q} />
      ))}
      {withFailures.length === 0 && (
        <p className="text-sm text-muted-foreground">Sin jobs fallidos recientes. 🎉</p>
      )}
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
