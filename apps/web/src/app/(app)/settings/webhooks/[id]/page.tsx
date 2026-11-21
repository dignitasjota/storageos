'use client';

import { WEBHOOK_EVENT_LABELS, type WebhookDeliveryDto } from '@storageos/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import {
  EditWebhookDialog,
  SendWebhookTestDialog,
} from '@/components/integrations/webhook-dialogs';
import { DateSelect } from '@/components/month-year-select';
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
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';
import {
  useRetryWebhookDelivery,
  useWebhookDeliveries,
  useWebhooks,
  type WebhookDeliveriesFilters,
} from '@/lib/integrations/hooks';

type StatusFilter = 'all' | 'pending' | 'success' | 'failed';

const eventLabel = (e: string): string =>
  e === 'ping' ? 'Prueba (ping)' : ((WEBHOOK_EVENT_LABELS as Record<string, string>)[e] ?? e);

export default function WebhookDetailPage() {
  const params = useParams<{ id: string }>();
  const webhookId = params.id;
  const {
    data: webhooks,
    isLoading: loadingWebhooks,
    isError: webhooksError,
    refetch: refetchWebhooks,
  } = useWebhooks();
  const webhook = useMemo(() => webhooks?.find((w) => w.id === webhookId), [webhooks, webhookId]);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [fromDate, setFromDate] = useState<string | undefined>();
  const [toDate, setToDate] = useState<string | undefined>();
  const [selected, setSelected] = useState<WebhookDeliveryDto | null>(null);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);

  // Los días van tal cual (`YYYY-MM-DD`): el servidor los toma en la zona del
  // negocio y «Hasta» incluye el día entero.
  const filters: WebhookDeliveriesFilters = useMemo(
    () => ({
      ...(status !== 'all' ? { status } : {}),
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
      limit: 50,
    }),
    [status, fromDate, toDate],
  );

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useWebhookDeliveries(webhookId, filters);
  const retry = useRetryWebhookDelivery(webhookId);

  const items = data?.pages.flatMap((p) => p.items) ?? [];

  const onRetry = async (deliveryId: string) => {
    try {
      await retry.mutateAsync(deliveryId);
      toast.success('Envío puesto en cola para reintentarlo.');
      setSelected(null);
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reintentar.');
    }
  };

  if (loadingWebhooks) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }
  if (webhooksError) {
    return <SectionError onRetry={() => void refetchWebhooks()} />;
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
            Los avisos que se han enviado y su resultado. Los que fallaron se pueden reintentar.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/integrations">Volver</Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Configuración</CardTitle>
            <CardDescription>A dónde se envían los avisos y cuáles.</CardDescription>
          </div>
          {webhook.isActive ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setTesting(true)}>
                Enviar prueba
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Editar
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Dirección: </span>
            <code className="break-all text-xs">{webhook.url}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Estado: </span>
            {webhook.isActive ? <Badge>Activo</Badge> : <Badge variant="outline">Revocado</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">Eventos suscritos: </span>
            {webhook.events.map((e) => (
              <Badge key={e} variant="outline" className="text-[10px]" title={e}>
                {eventLabel(e)}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Envíos</CardTitle>
          <CardDescription>
            Los más recientes primero. Los que han fallado se pueden reintentar desde su detalle.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="w-full space-y-1 sm:w-44">
              <Label htmlFor="filter-status">Estado</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <SelectTrigger id="filter-status">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="pending">Pendiente</SelectItem>
                  <SelectItem value="success">Entregado</SelectItem>
                  <SelectItem value="failed">Fallido</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Desde</Label>
              <DateSelect value={fromDate} onChange={setFromDate} />
            </div>
            <div className="space-y-1">
              <Label>Hasta</Label>
              <DateSelect value={toDate} onChange={setToDate} />
            </div>
            {(fromDate || toDate || status !== 'all') && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus('all');
                  setFromDate(undefined);
                  setToDate(undefined);
                }}
              >
                Quitar los filtros
              </Button>
            )}
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : isError ? (
            <SectionError onRetry={() => void refetch()} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay envíos con estos filtros.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Respuesta</TableHead>
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
                        {formatDateTime(d.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs" title={d.eventType}>
                        {eventLabel(d.eventType)}
                        {d.payload.test === true ? (
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            Prueba
                          </Badge>
                        ) : null}
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

          {hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <EditWebhookDialog webhook={editing ? webhook : null} onClose={() => setEditing(false)} />
      <SendWebhookTestDialog
        webhook={testing ? webhook : null}
        onClose={() => setTesting(false)}
        showDeliveriesLink={false}
      />

      <DeliveryDetailDialog
        delivery={selected}
        onClose={() => setSelected(null)}
        onRetry={onRetry}
        retrying={retry.isPending}
      />
    </div>
  );
}

const STATUS_LABELS: Record<'pending' | 'success' | 'failed', string> = {
  pending: 'Pendiente',
  success: 'Entregado',
  failed: 'Fallido',
};

function StatusBadge({ status }: { status: 'pending' | 'success' | 'failed' }) {
  if (status === 'success') return <Badge>{STATUS_LABELS.success}</Badge>;
  if (status === 'failed') return <Badge variant="destructive">{STATUS_LABELS.failed}</Badge>;
  return <Badge variant="outline">{STATUS_LABELS.pending}</Badge>;
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
          <DialogTitle>Detalle del envío</DialogTitle>
        </DialogHeader>
        {delivery ? (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <Field
                label="Evento"
                value={`${eventLabel(delivery.eventType)} (${delivery.eventType})`}
              />
              <Field label="Estado" value={STATUS_LABELS[delivery.status]} />
              <Field label="Código de respuesta" value={String(delivery.statusCode ?? '—')} />
              <Field label="Intentos" value={String(delivery.attempts)} />
              <Field label="Creado" value={formatDateTime(delivery.createdAt)} />
              <Field
                label="Entregado"
                value={delivery.deliveredAt ? formatDateTime(delivery.deliveredAt) : '—'}
              />
            </div>
            <div>
              <Label className="text-xs">Firma (cabecera X-Storageos-Signature)</Label>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-[10px]">
                {delivery.signature}
              </pre>
            </div>
            <div>
              <Label className="text-xs">Contenido enviado</Label>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[10px]">
                {JSON.stringify(delivery.payload, null, 2)}
              </pre>
            </div>
            {delivery.responseBody ? (
              <div>
                <Label className="text-xs">Respuesta de tu servidor</Label>
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
