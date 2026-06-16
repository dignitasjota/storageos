'use client';

import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminWebhooksCleanupRun, useAdminWebhooksCleanupStats } from '@/lib/admin/hooks';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES');
}

function daysAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days === 0) return 'hoy';
  if (days === 1) return 'hace 1 día';
  return `hace ${days} días`;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  success: 'default',
  pending: 'secondary',
  failed: 'destructive',
};

export default function WebhooksCleanupPage() {
  const [olderThanInput, setOlderThanInput] = useState<string>('');
  const olderThanNum = olderThanInput ? Number(olderThanInput) : undefined;
  const validOverride = olderThanNum !== undefined && olderThanNum > 0 ? olderThanNum : undefined;

  const stats = useAdminWebhooksCleanupStats(validOverride);
  const run = useAdminWebhooksCleanupRun();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<{ deleted: number; olderThanDays: number } | null>(
    null,
  );

  async function handleRun() {
    const result = await run.mutateAsync({ olderThanDays: validOverride });
    setLastResult(result);
    setConfirmOpen(false);
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold">Cleanup webhook_deliveries</h1>
        <p className="text-muted-foreground text-sm">
          Estado actual de entregas + purga manual. El cron diario corre a las 04:00 UTC con la
          retención configurada por env (default 30 días).
        </p>
      </header>

      {/* Override de retention */}
      <Card>
        <CardHeader>
          <CardTitle>Ventana de retención</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <Label htmlFor="older-than">Días (override del default)</Label>
            <Input
              id="older-than"
              type="number"
              min={1}
              placeholder={`Default: ${stats.data?.olderThanDays ?? 30}`}
              value={olderThanInput}
              onChange={(e) => setOlderThanInput(e.target.value)}
            />
          </div>
          <p className="text-muted-foreground pb-2 text-xs">
            Las stats se recalculan según este override. Vacío = usar default env.
          </p>
        </CardContent>
      </Card>

      {stats.isLoading && (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Cargando stats…
        </div>
      )}

      {stats.error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-destructive">Error cargando stats</CardContent>
        </Card>
      )}

      {stats.data && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <KpiCard label="Total deliveries" value={stats.data.total} />
            <KpiCard
              label={`Elegibles para purga (>${stats.data.olderThanDays}d)`}
              value={stats.data.eligibleForCleanup}
              danger={stats.data.eligibleForCleanup > 0}
            />
            <KpiCard label="Más antiguo" value={daysAgo(stats.data.oldestAt)} isText />
            <KpiCard label="Más reciente" value={daysAgo(stats.data.newestAt)} isText />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Distribución por status</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.data.byStatus.length === 0 ? (
                <p className="text-muted-foreground text-sm">Sin deliveries</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {stats.data.byStatus.map((b) => (
                    <Badge key={b.status} variant={STATUS_VARIANT[b.status] ?? 'outline'}>
                      {b.status}
                      <span className="ml-2 font-mono">{b.count}</span>
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Ventana de purga</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between border-b pb-2">
                <span className="text-muted-foreground">Cutoff</span>
                <span className="font-mono">{formatDate(stats.data.cutoff)}</span>
              </div>
              <div className="flex justify-between border-b pb-2">
                <span className="text-muted-foreground">Más viejo en BD</span>
                <span className="font-mono">{formatDate(stats.data.oldestAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Más reciente en BD</span>
                <span className="font-mono">{formatDate(stats.data.newestAt)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Botón ejecutar */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trash2 className="size-4" />
                Ejecutar purga manual
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Borra todos los <code className="font-mono">webhook_deliveries</code> con
                <code className="font-mono"> created_at &lt; {formatDate(stats.data.cutoff)}</code>.
                Operación irreversible.
              </p>
              <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={stats.data.eligibleForCleanup === 0 || run.isPending}
                  >
                    {run.isPending ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" /> Ejecutando…
                      </>
                    ) : (
                      <>Ejecutar purga ({stats.data.eligibleForCleanup})</>
                    )}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-destructive">
                      <AlertTriangle className="size-5" />
                      Confirmar purga destructiva
                    </DialogTitle>
                    <DialogDescription>
                      Vas a borrar <strong>{stats.data.eligibleForCleanup}</strong> deliveries con
                      más de <strong>{stats.data.olderThanDays}</strong> días. No se puede deshacer.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                      Cancelar
                    </Button>
                    <Button variant="destructive" onClick={handleRun} disabled={run.isPending}>
                      Sí, borrar definitivamente
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {lastResult && (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  Última ejecución: <strong>{lastResult.deleted}</strong> deliveries borrados
                  (cutoff {lastResult.olderThanDays}d).
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  danger = false,
  isText = false,
}: {
  label: string;
  value: number | string;
  danger?: boolean;
  isText?: boolean;
}) {
  return (
    <Card className={danger ? 'border-destructive' : ''}>
      <CardContent className="pt-6">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
        <p
          className={`mt-2 font-bold ${isText ? 'text-lg' : 'text-3xl'} ${
            danger ? 'text-destructive' : ''
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
