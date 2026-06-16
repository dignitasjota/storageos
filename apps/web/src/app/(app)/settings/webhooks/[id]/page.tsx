'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { WebhookDeliveryDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useRetryWebhookDelivery,
  useWebhookDeliveries,
  useWebhooks,
  type WebhookDeliveriesFilters,
} from '@/lib/integrations/hooks';

type StatusFilter = 'all' | 'pending' | 'success' | 'failed';

export default function WebhookDetailPage() {
  const params = useParams<{ id: string }>();
  const webhookId = params.id;
  const { data: webhooks, isLoading: loadingWebhooks } = useWebhooks();
  const webhook = useMemo(() => webhooks?.find((w) => w.id === webhookId), [webhooks, webhookId]);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<WebhookDeliveryDto[]>([]);
  const [selected, setSelected] = useState<WebhookDeliveryDto | null>(null);

  const filters: WebhookDeliveriesFilters = useMemo(
    () => ({
      ...(status !== 'all' ? { status } : {}),
      ...(fromDate ? { fromDate: new Date(fromDate).toISOString() } : {}),
      ...(toDate ? { toDate: new Date(toDate).toISOString() } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
    [status, fromDate, toDate, cursor],
  );

  const { data, isLoading, isFetching, refetch } = useWebhookDeliveries(webhookId, filters);
  const retry = useRetryWebhookDelivery(webhookId);

  const resetPagination = () => {
    setCursor(undefined);
    setAccumulated([]);
  };

  const onFilterChange = (next: () => void) => {
    next();
    resetPagination();
  };

  const items = cursor ? [...accumulated, ...(data?.items ?? [])] : (data?.items ?? []);
  const nextCursor = data?.nextCursor ?? null;

  const loadMore = () => {
    if (!nextCursor) return;
    setAccumulated(items);
    setCursor(nextCursor);
  };

  const onRetry = async (deliveryId: string) => {
    try {
      await retry.mutateAsync(deliveryId);
      toast.success('Delivery encolada para reintento');
      setSelected(null);
      resetPagination();
      await refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al reintentar';
      toast.error(msg);
    }
  };

  if (loadingWebhooks) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }
  if (!webhook) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Webhook no encontrado.</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/integrations">Volver</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{webhook.name}</h1>
          <p className="text-sm text-muted-foreground">
            Historial de entregas y reintentos manuales
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/integrations">Volver</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuración</CardTitle>
          <CardDescription>Datos del webhook tal como fueron registrados.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">URL: </span>
            <code className="text-xs">{webhook.url}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Estado: </span>
            {webhook.isActive ? <Badge>Activo</Badge> : <Badge variant="outline">Revocado</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">Eventos suscritos: </span>
            {webhook.events.map((e) => (
              <Badge key={e} variant="outline" className="text-[10px]">
                {e}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entregas</CardTitle>
          <CardDescription>
            Últimos intentos. Las entregas con estado `failed` permiten reintento manual.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="filter-status">Estado</Label>
              <Select
                value={status}
                onValueChange={(v) => onFilterChange(() => setStatus(v as StatusFilter))}
              >
                <SelectTrigger id="filter-status">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="filter-from">Desde</Label>
              <Input
                id="filter-from"
                type="date"
                value={fromDate}
                onChange={(e) => onFilterChange(() => setFromDate(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="filter-to">Hasta</Label>
              <Input
                id="filter-to"
                type="date"
                value={toDate}
                onChange={(e) => onFilterChange(() => setToDate(e.target.value))}
              />
            </div>
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay entregas con estos filtros.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>HTTP</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Intentos</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((d) => (
                    <TableRow
                      key={d.id}
                      className="cursor-pointer hover:bg-muted"
                      onClick={() => setSelected(d)}
                    >
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(d.createdAt).toLocaleString('es-ES')}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs">{d.eventType}</code>
                      </TableCell>
                      <TableCell className="text-xs">{d.statusCode ?? '—'}</TableCell>
                      <TableCell>
                        <StatusBadge status={d.status} />
                      </TableCell>
                      <TableCell className="text-xs">{d.attempts}</TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-destructive">
                        {d.errorMessage ?? ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {nextCursor ? (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={isFetching}>
                Cargar más
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <DeliveryDetailDialog
        delivery={selected}
        onClose={() => setSelected(null)}
        onRetry={onRetry}
        retrying={retry.isPending}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: 'pending' | 'success' | 'failed' }) {
  if (status === 'success') return <Badge>success</Badge>;
  if (status === 'failed') return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="outline">pending</Badge>;
}

function DeliveryDetailDialog({
  delivery,
  onClose,
  onRetry,
  retrying,
}: {
  delivery: WebhookDeliveryDto | null;
  onClose: () => void;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  return (
    <Dialog open={!!delivery} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Detalle de la entrega</DialogTitle>
        </DialogHeader>
        {delivery ? (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <Field label="Evento" value={delivery.eventType} />
              <Field label="Estado" value={delivery.status} />
              <Field label="HTTP" value={String(delivery.statusCode ?? '—')} />
              <Field label="Intentos" value={String(delivery.attempts)} />
              <Field label="Creado" value={new Date(delivery.createdAt).toLocaleString('es-ES')} />
              <Field
                label="Entregado"
                value={
                  delivery.deliveredAt
                    ? new Date(delivery.deliveredAt).toLocaleString('es-ES')
                    : '—'
                }
              />
            </div>
            <div>
              <Label className="text-xs">Signature</Label>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-[10px]">
                {delivery.signature}
              </pre>
            </div>
            <div>
              <Label className="text-xs">Payload</Label>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[10px]">
                {JSON.stringify(delivery.payload, null, 2)}
              </pre>
            </div>
            {delivery.responseBody ? (
              <div>
                <Label className="text-xs">Response body</Label>
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 text-[10px]">
                  {delivery.responseBody}
                </pre>
              </div>
            ) : null}
            {delivery.errorMessage ? (
              <div>
                <Label className="text-xs">Error</Label>
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-destructive/10 p-2 text-[10px] text-destructive">
                  {delivery.errorMessage}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          {delivery?.status === 'failed' ? (
            <Button onClick={() => onRetry(delivery.id)} disabled={retrying}>
              Reintentar
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
