'use client';

import {
  OFFERED_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_HINTS,
  WEBHOOK_EVENT_LABELS,
  type WebhookDto,
  type WebhookEventType,
  type WebhookTestEvent,
} from '@storageos/shared';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { ApiError } from '@/lib/auth/api';
import { useSendWebhookTest, useUpdateWebhook } from '@/lib/integrations/hooks';

const EVENT_TYPES: WebhookEventType[] = [...OFFERED_WEBHOOK_EVENTS];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.body.message : fallback;
}

/** Casillas de eventos con lo que significa cada uno. */
export function WebhookEventsPicker({
  value,
  onChange,
}: {
  value: WebhookEventType[];
  onChange: (next: WebhookEventType[]) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {EVENT_TYPES.map((e) => {
        const checked = value.includes(e);
        return (
          <label key={e} className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={checked}
              onCheckedChange={(v) => {
                const isOn = v === true;
                onChange(isOn ? [...value, e] : value.filter((x) => x !== e));
              }}
            />
            <span className="space-y-0.5">
              <span className="block">
                {WEBHOOK_EVENT_LABELS[e]} <code className="text-xs text-muted-foreground">{e}</code>
              </span>
              <span className="block text-xs text-muted-foreground">{WEBHOOK_EVENT_HINTS[e]}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Cambiar nombre, dirección y eventos de un webhook. */
export function EditWebhookDialog({
  webhook,
  onClose,
}: {
  webhook: WebhookDto | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!webhook} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {webhook ? <EditWebhookForm key={webhook.id} webhook={webhook} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditWebhookForm({ webhook, onClose }: { webhook: WebhookDto; onClose: () => void }) {
  const update = useUpdateWebhook(webhook.id);
  const [name, setName] = useState(webhook.name);
  const [url, setUrl] = useState(webhook.url);
  // Un evento que ya no se ofrece (el nombre antiguo) se conserva si estaba.
  const [events, setEvents] = useState<WebhookEventType[]>(webhook.events);

  const changed =
    name.trim() !== webhook.name ||
    url.trim() !== webhook.url ||
    events.length !== webhook.events.length ||
    events.some((e) => !webhook.events.includes(e));

  const submit = async () => {
    if (!name.trim() || !url.trim() || events.length === 0) return;
    try {
      await update.mutateAsync({
        ...(name.trim() !== webhook.name ? { name: name.trim() } : {}),
        ...(url.trim() !== webhook.url ? { url: url.trim() } : {}),
        events,
      });
      toast.success('Webhook guardado.');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar el webhook.'));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Editar webhook</DialogTitle>
        <DialogDescription>
          El secreto para la firma no cambia. Para uno nuevo, usa «Renovar secreto».
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="wh-edit-name">Nombre</Label>
          <Input id="wh-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="wh-edit-url">Dirección (https)</Label>
          <Input id="wh-edit-url" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Eventos suscritos</Label>
          <WebhookEventsPicker value={events} onChange={setEvents} />
          {events.length === 0 ? (
            <p className="text-xs text-destructive">Marca al menos un evento.</p>
          ) : null}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={
            !changed || !name.trim() || !url.trim() || events.length === 0 || update.isPending
          }
        >
          Guardar
        </Button>
      </DialogFooter>
    </>
  );
}

/** Mandar un aviso de prueba (de verdad, firmado) para comprobar la dirección. */
export function SendWebhookTestDialog({
  webhook,
  onClose,
  showDeliveriesLink = true,
}: {
  webhook: WebhookDto | null;
  onClose: () => void;
  /** En la ficha del webhook ya se ven los envíos: sin enlace. */
  showDeliveriesLink?: boolean;
}) {
  return (
    <Dialog open={!!webhook} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        {webhook ? (
          <SendTestForm
            key={webhook.id}
            webhook={webhook}
            onClose={onClose}
            showDeliveriesLink={showDeliveriesLink}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SendTestForm({
  webhook,
  onClose,
  showDeliveriesLink,
}: {
  webhook: WebhookDto;
  onClose: () => void;
  showDeliveriesLink: boolean;
}) {
  const send = useSendWebhookTest(webhook.id);
  const [event, setEvent] = useState<WebhookTestEvent>('ping');

  const submit = async () => {
    try {
      await send.mutateAsync({ event });
      toast.success(
        showDeliveriesLink
          ? 'Prueba enviada. Mira el resultado en sus envíos.'
          : 'Prueba enviada: aparecerá en la lista de envíos en unos segundos.',
      );
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo enviar la prueba.'));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Enviar una prueba</DialogTitle>
        <DialogDescription>
          Mandamos a <code className="break-all text-xs">{webhook.url}</code> un aviso de verdad,
          firmado como los demás, con datos de ejemplo y <code className="text-xs">test: true</code>{' '}
          en el cuerpo. Llega aunque el webhook no esté suscrito a ese evento.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor="wh-test-event">Qué aviso</Label>
        <Select value={event} onValueChange={(v) => setEvent(v as WebhookTestEvent)}>
          <SelectTrigger id="wh-test-event">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ping">Prueba sencilla (ping)</SelectItem>
            {EVENT_TYPES.map((e) => (
              <SelectItem key={e} value={e}>
                {WEBHOOK_EVENT_LABELS[e]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DialogFooter className="gap-2 sm:gap-0">
        {showDeliveriesLink ? (
          <Button variant="ghost" asChild>
            <Link href={`/settings/webhooks/${webhook.id}`}>Ver los envíos</Link>
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={() => void submit()} disabled={send.isPending}>
          {send.isPending ? 'Enviando…' : 'Enviar prueba'}
        </Button>
      </DialogFooter>
    </>
  );
}
